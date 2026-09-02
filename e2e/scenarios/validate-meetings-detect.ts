import { createServer } from "node:http";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import initSqlJs from "sql.js";
import { captureLogs, screenshot } from "../driver/capture";
import { queryDb } from "../driver/inspect";
import { launchApp, REPO_ROOT, resolveRealUserData } from "../driver/launch";
import { goToArea, waitReady } from "../driver/nav";

// W2: detecção automática de reunião via PipeWire (synthetic script), sem
// pw-dump real — CM_MEETING_DETECT_SCRIPT substitui o pw-dump por uma
// timeline determinística (meeting-detector.ts: parseScript/scriptDump).
// Três fases = três launchApp() independentes (perfil podado do zero em cada
// uma), pra manter o clock do detector isolado por fase.

const require = createRequire(import.meta.url);
const FIXTURES = join(REPO_ROOT, "e2e/fixtures/meetings");

type Verdict = "PASS" | "FAIL" | "SKIP" | "INFO";
const report: Array<{ step: string; verdict: Verdict; evidence: string }> = [];
function record(step: string, verdict: Verdict, evidence: string): void {
  report.push({ step, verdict, evidence });
  console.log(`[${verdict}] ${step} — ${evidence}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function prunedBaseProfile(
  extraPrefs?: Array<[string, unknown]>,
): Promise<string> {
  const real = resolveRealUserData();
  const dir = mkdtempSync(join(tmpdir(), "cm-meetings-detect-base-"));
  process.once("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });
  cpSync(join(real, "app.db"), join(dir, "app.db"));
  const SQL = await initSqlJs({
    locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm"),
  });
  const db = new SQL.Database(readFileSync(join(dir, "app.db")));
  db.run(
    "UPDATE workspace_state SET dock_layout = NULL, open_panes = NULL WHERE id = 1",
  );
  db.run("INSERT OR REPLACE INTO app_prefs (key, value) VALUES (?, ?)", [
    "autoPullEnabled",
    JSON.stringify(false),
  ]);
  try {
    db.run("DELETE FROM meetings_v2");
  } catch {
    // tabela ausente: a migração cria no boot
  }
  for (const [key, value] of extraPrefs ?? []) {
    db.run("INSERT OR REPLACE INTO app_prefs (key, value) VALUES (?, ?)", [
      key,
      JSON.stringify(value),
    ]);
  }
  writeFileSync(join(dir, "app.db"), Buffer.from(db.export()));
  db.close();
  return dir;
}

// --- fake STT: rotaciona frases do manifest (mesmo esquema do v2) ----------
interface ManifestEntry {
  file: string;
  seconds: number;
  transcript: string;
}
const manifest = JSON.parse(
  readFileSync(join(FIXTURES, "manifest.json"), "utf8"),
) as ManifestEntry[];
const phrases = manifest
  .filter((m) => m.transcript.trim())
  .flatMap((m) => m.transcript.split(/(?<=[.!?])\s+/).map((s) => s.trim()))
  .filter(Boolean);

const sttCalls: string[] = [];
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const n = sttCalls.length;
    const phrase = phrases[n % phrases.length];
    sttCalls.push(`#${n + 1} → "${phrase.slice(0, 40)}…"`);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        text: phrase,
        language: "pt",
        duration: 12,
        segments: [{ id: n, start: 1.5, end: 6.0, text: phrase, no_speech_prob: 0.05 }],
      }),
    );
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
console.log(`[fake-stt] ouvindo em 127.0.0.1:${port} (${phrases.length} frases)`);

const summaryFixture = join(FIXTURES, "summary-fixture.json");
const systemWav = join(FIXTURES, "system-participante.wav");
const micWav = join(FIXTURES, "mic-eu.wav");
for (const f of [summaryFixture, systemWav, micWav]) {
  if (!existsSync(f)) throw new Error(`fixture ausente: ${f}`);
}

const baseEnv = {
  VOZ_STT_URL: `http://127.0.0.1:${port}/v1/audio/transcriptions`,
  VOZ_STT_KEY: "fake",
  CM_MEETING_FIXTURE_SYSTEM: systemWav,
  CM_MEETING_FIXTURE_MIC: micWav,
  CM_MEETING_FIXTURE_PACE: "1",
  CM_MEETING_SUMMARY_FIXTURE: summaryFixture,
};

const errors: string[] = [];
function watchErrors(p: Page, tag: string): void {
  p.on("pageerror", (e) => errors.push(`${tag} pageerror: ${e.message}`));
  p.on("console", (m) => {
    if (m.type() === "error") errors.push(`${tag} console.error: ${m.text()}`);
  });
}

interface ApiMeeting {
  id: string;
  status: string;
}
interface ApiDetection {
  app: string;
  binary: string;
  streamId: number;
  ignored: boolean;
}
interface ApiLiveState {
  active: ApiMeeting | null;
  detection: ApiDetection | null;
  captureMode: string;
}
interface ApiDetail {
  meeting: ApiMeeting;
  segments: Array<{ speaker: string; text: string }>;
}

function bindApi(page: Page) {
  const apiState = () =>
    page.evaluate(() =>
      (window as unknown as { api: { meetings: { state: () => Promise<unknown> } } }).api.meetings.state(),
    ) as Promise<ApiLiveState>;
  const apiGet = (id: string) =>
    page.evaluate(
      (mid) =>
        (window as unknown as { api: { meetings: { get: (id: string) => Promise<unknown> } } }).api.meetings.get(mid),
      id,
    ) as Promise<ApiDetail>;
  const apiList = () =>
    page.evaluate(() =>
      (window as unknown as { api: { meetings: { list: () => Promise<unknown> } } }).api.meetings.list(),
    ) as Promise<ApiMeeting[]>;
  return { apiState, apiGet, apiList };
}

async function stopIfActive(page: Page): Promise<void> {
  try {
    const s = await page.evaluate(() =>
      (window as unknown as { api: { meetings: { state: () => Promise<{ active: unknown }> } } }).api.meetings.state(),
    );
    if (s.active) {
      await page.evaluate(() =>
        (window as unknown as { api: { meetings: { stop: () => Promise<unknown> } } }).api.meetings.stop(),
      );
    }
  } catch {
    // app já morto
  }
}

// ============================================================================
// FASE 1 — detecção → Gravar → transcript → stream some → auto-stop
// ============================================================================
async function phase1(): Promise<void> {
  console.log("\n=== FASE 1: detectar, gravar, auto-stop ===");
  process.env.CM_REAL_USERDATA = await prunedBaseProfile();
  const { app, page, userDataCopy } = await launchApp({
    env: { ...baseEnv, CM_MEETING_DETECT_SCRIPT: "2:chrome,30:none" },
  });
  const { logFile, stop: stopLogs } = captureLogs(app, page);
  watchErrors(page, "p1-main");
  const { apiState, apiGet } = bindApi(page);
  const t0 = Date.now();
  let meetingId: string | null = null;
  try {
    await waitReady(page);
    await goToArea(page, "meetings");

    // --- (a) banner + pill amber em ≤8s ------------------------------------
    const banner = page.getByRole("status").filter({ hasText: "está usando o microfone" });
    let detectMs = -1;
    const deadlineA = Date.now() + 15_000;
    while (Date.now() < deadlineA) {
      if (await banner.isVisible().catch(() => false)) {
        detectMs = Date.now() - t0;
        break;
      }
      await sleep(200);
    }
    const shot01 = await screenshot(page, "meetings-detect-01-banner");
    const pill = page.getByTitle(/está usando o microfone/).first();
    const pillVisible = await pill.isVisible().catch(() => false);
    record(
      "(a) banner + pill âmbar após detecção",
      detectMs >= 0 && detectMs <= 8000 && pillVisible ? "PASS" : detectMs >= 0 ? "FAIL" : "FAIL",
      `${shot01} · detectMs=${detectMs} (alvo ≤8000) pillVisível=${pillVisible}`,
    );
    if (detectMs < 0) throw new Error("FALHA (a): banner de detecção nunca apareceu");

    // --- (b) pill em outra área ---------------------------------------------
    await goToArea(page, "tasks");
    const pillOther = page.getByTitle(/está usando o microfone/).first();
    const pillOtherVisible = await pillOther
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    const shot02 = await screenshot(page, "meetings-detect-02-pill-other-area");
    record(
      "(b) pill âmbar visível fora de Reuniões",
      pillOtherVisible ? "PASS" : "FAIL",
      `${shot02} · visível=${pillOtherVisible}`,
    );
    await goToArea(page, "meetings");
    await banner.waitFor({ state: "visible", timeout: 5_000 });

    // --- (c) clicar Gravar → hero Gravando, pill vermelho, banner some ------
    await page.getByRole("button", { name: "Gravar" }).first().click();
    const hero = page.getByText(/^Gravando/).first();
    await hero.waitFor({ state: "visible", timeout: 10_000 });
    const state = await apiState();
    meetingId = state.active?.id ?? null;
    const recordingPill = page.getByRole("button", { name: /^Gravando \d\d:\d\d/ });
    const recordingPillVisible = await recordingPill
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    const bannerGone = !(await banner.isVisible().catch(() => false));
    const shot03 = await screenshot(page, "meetings-detect-03-recording");
    if (!meetingId) throw new Error("FALHA (c): clicou Gravar mas não há reunião ativa");
    record(
      "(c) Gravar → hero Gravando + pill vermelho + banner some",
      recordingPillVisible && bannerGone ? "PASS" : "FAIL",
      `${shot03} · meeting=${meetingId} pillVermelho=${recordingPillVisible} bannerSumiu=${bannerGone}`,
    );

    // --- (d) ≥2 segmentos no transcript --------------------------------------
    let segCount = 0;
    const deadlineD = Date.now() + 45_000;
    while (Date.now() < deadlineD) {
      const d = await apiGet(meetingId);
      segCount = d.segments.length;
      if (segCount >= 2) break;
      await sleep(1_000);
    }
    const shot04 = await screenshot(page, "meetings-detect-04-transcript");
    record(
      "(d) ≥2 segmentos ao vivo",
      segCount >= 2 ? "PASS" : "FAIL",
      `${shot04} · segmentos=${segCount} chamadasSTT=${sttCalls.length}`,
    );

    // --- (e) stream some (t=30s do script) → auto-stop ≤20s depois -----------
    let sawActiveNull = false;
    let autoStopMs = -1;
    let toastSeen = false;
    const deadlineE = Date.now() + 60_000;
    while (Date.now() < deadlineE) {
      const s = await apiState();
      if (!s.active) {
        sawActiveNull = true;
        autoStopMs = Date.now() - t0;
        break;
      }
      await sleep(1_000);
    }
    if (sawActiveNull) {
      const deadlineToast = Date.now() + 6_500;
      while (Date.now() < deadlineToast && !toastSeen) {
        toastSeen = await page
          .getByText("A chamada terminou.", { exact: true })
          .isVisible()
          .catch(() => false);
        if (!toastSeen) await sleep(200);
      }
    }
    const shot05 = await screenshot(page, "meetings-detect-05-autostop");
    // 30s (fim do stream no script) + END_MS(8s, granularidade de poll) + GRACE_MS(8s)
    record(
      "(e) auto-stop após stream sumir (janela ~30s+16s de histerese)",
      sawActiveNull && autoStopMs <= 30_000 + 25_000 ? "PASS" : "FAIL",
      `${shot05} · autoStopMs=${autoStopMs} (desde t0) toast\"A chamada terminou.\"=${toastSeen}`,
    );

    // --- (f) status final Processando/Concluída ------------------------------
    let finalStatus = "";
    const deadlineF = Date.now() + 30_000;
    while (Date.now() < deadlineF) {
      const d = await apiGet(meetingId);
      finalStatus = d.meeting.status;
      if (finalStatus === "done" || finalStatus === "error") break;
      await sleep(500);
    }
    const shot06 = await screenshot(page, "meetings-detect-06-final-status");
    record(
      "(f) status final done/processing (não travado em recording)",
      finalStatus === "done" || finalStatus === "processing" ? "PASS" : "FAIL",
      `${shot06} · finalStatus=${finalStatus}`,
    );
  } catch (err) {
    console.log("[fase1 erro]", err instanceof Error ? err.message : String(err));
    await screenshot(page, "meetings-detect-99-fase1-failure").catch(() => {});
    if (!report.some((r) => r.verdict === "FAIL"))
      record("fase1 execução", "FAIL", err instanceof Error ? err.message : String(err));
  } finally {
    await stopIfActive(page);
    stopLogs();
    await app.close();
  }

  // --- (g) banco: reunião done, segmentos > 0 --------------------------------
  if (meetingId) {
    const meetings = await queryDb<{ status: string }>(
      userDataCopy,
      `SELECT status FROM meetings_v2 WHERE id = '${meetingId}'`,
    );
    const segRows = await queryDb<{ c: number }>(
      userDataCopy,
      `SELECT COUNT(*) AS c FROM meeting_v2_segments WHERE meeting_id = '${meetingId}'`,
    );
    const segCount = segRows[0]?.c ?? 0;
    record(
      "(g) queryDb: reunião done + segmentos > 0",
      meetings[0]?.status === "done" && segCount > 0 ? "PASS" : "FAIL",
      `status=${meetings[0]?.status} segmentos=${segCount}`,
    );
  } else {
    record("(g) queryDb", "SKIP", "sem meetingId — fase 1 falhou antes de gravar");
  }

  // --- (h) action items só propostos: 0 tasks origin=auto até seleção -------
  if (meetingId) {
    const items = await queryDb<{ status: string }>(
      userDataCopy,
      `SELECT status FROM meeting_v2_action_items WHERE meeting_id = '${meetingId}'`,
    );
    const autoTasks = await queryDb<{ c: number }>(
      userDataCopy,
      `SELECT COUNT(*) AS c FROM tasks WHERE origin = 'auto' AND created_at >= ${t0}`,
    );
    const autoTaskCount = autoTasks[0]?.c ?? 0;
    const allProposed = items.length > 0 && items.every((i) => i.status === "proposed");
    record(
      "(h) action items proposed + 0 tasks origin=auto até seleção",
      allProposed && autoTaskCount === 0 ? "PASS" : "FAIL",
      `items=${JSON.stringify(items)} tasksOrigemAuto=${autoTaskCount}`,
    );
  } else {
    record("(h) queryDb action items", "SKIP", "sem meetingId — fase 1 falhou antes de gravar");
  }
  console.log("log fase1:", logFile);
}

// ============================================================================
// FASE 2 — detecção → Ignorar → nada grava
// ============================================================================
async function phase2(): Promise<void> {
  console.log("\n=== FASE 2: detectar, Ignorar, nada grava ===");
  process.env.CM_REAL_USERDATA = await prunedBaseProfile();
  const { app, page, userDataCopy: _u } = await launchApp({
    env: { ...baseEnv, CM_MEETING_DETECT_SCRIPT: "2:zoom,30:none" },
  });
  const { logFile, stop: stopLogs } = captureLogs(app, page);
  watchErrors(page, "p2-main");
  const { apiState, apiList } = bindApi(page);
  try {
    await waitReady(page);
    await goToArea(page, "meetings");
    const banner = page.getByRole("status").filter({ hasText: "está usando o microfone" });
    await banner.waitFor({ state: "visible", timeout: 15_000 });
    const shot01 = await screenshot(page, "meetings-detect-07-zoom-banner");
    await page.getByRole("button", { name: "Ignorar" }).first().click();
    await sleep(500);
    const bannerGone = !(await banner.isVisible().catch(() => false));
    const pillGone = !(await page
      .getByTitle(/está usando o microfone/)
      .isVisible()
      .catch(() => false));
    const shot02 = await screenshot(page, "meetings-detect-08-zoom-ignored");
    record(
      "(g2) Ignorar → banner e pill somem",
      bannerGone && pillGone ? "PASS" : "FAIL",
      `${shot01}, ${shot02} · bannerSumiu=${bannerGone} pillSumiu=${pillGone}`,
    );
    await sleep(6_000);
    const s = await apiState();
    const list = await apiList();
    record(
      "(g3) nada grava após Ignorar (6s de observação)",
      !s.active && list.length === 0 ? "PASS" : "FAIL",
      `active=${JSON.stringify(s.active)} meetings=${list.length}`,
    );
  } catch (err) {
    console.log("[fase2 erro]", err instanceof Error ? err.message : String(err));
    await screenshot(page, "meetings-detect-99-fase2-failure").catch(() => {});
    record("fase2 execução", "FAIL", err instanceof Error ? err.message : String(err));
  } finally {
    await stopIfActive(page);
    stopLogs();
    await app.close();
  }
  console.log("log fase2:", logFile);
}

// ============================================================================
// FASE 3 — meeting_auto_record=true → grava sozinha, para sozinha
// ============================================================================
async function phase3(): Promise<void> {
  console.log("\n=== FASE 3: meeting_auto_record=true ===");
  process.env.CM_REAL_USERDATA = await prunedBaseProfile([["meeting_auto_record", true]]);
  const { app, page, userDataCopy } = await launchApp({
    env: { ...baseEnv, CM_MEETING_DETECT_SCRIPT: "2:chrome,30:none" },
  });
  const { logFile, stop: stopLogs } = captureLogs(app, page);
  watchErrors(page, "p3-main");
  const { apiState } = bindApi(page);
  let meetingId: string | null = null;
  try {
    await waitReady(page);
    await goToArea(page, "meetings");
    const hero = page.getByText(/^Gravando/).first();
    const autoStarted = await hero
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const s1 = await apiState();
    meetingId = s1.active?.id ?? null;
    const shot01 = await screenshot(page, "meetings-detect-09-auto-record");
    record(
      "(h1) meeting_auto_record=true → grava sem clique",
      autoStarted && !!meetingId ? "PASS" : "FAIL",
      `${shot01} · autoStarted=${autoStarted} meeting=${meetingId}`,
    );
    if (!meetingId) throw new Error("FALHA (h1): auto-record não iniciou gravação");

    let sawActiveNull = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const s = await apiState();
      if (!s.active) {
        sawActiveNull = true;
        break;
      }
      await sleep(1_000);
    }
    const shot02 = await screenshot(page, "meetings-detect-10-auto-record-stopped");
    record(
      "(h2) auto-record: para sozinha quando o stream some",
      sawActiveNull ? "PASS" : "FAIL",
      `${shot02} · parouSozinha=${sawActiveNull}`,
    );
  } catch (err) {
    console.log("[fase3 erro]", err instanceof Error ? err.message : String(err));
    await screenshot(page, "meetings-detect-99-fase3-failure").catch(() => {});
    record("fase3 execução", "FAIL", err instanceof Error ? err.message : String(err));
  } finally {
    await stopIfActive(page);
    stopLogs();
    await app.close();
  }
  if (meetingId) {
    const meetings = await queryDb<{ status: string }>(
      userDataCopy,
      `SELECT status FROM meetings_v2 WHERE id = '${meetingId}'`,
    );
    record(
      "(h3) queryDb: reunião auto-gravada chegou a done/processing",
      meetings[0]?.status === "done" || meetings[0]?.status === "processing" ? "PASS" : "FAIL",
      `status=${meetings[0]?.status}`,
    );
  }
  console.log("log fase3:", logFile);
}

// ============================================================================
await phase1();
await phase2();
await phase3();
server.close();

console.log("\n=== FAKE STT: chamadas ===");
console.log(sttCalls.length ? sttCalls.join("\n") : "nenhuma");
console.log("\n=== ERROS DE CONSOLE/PAGEERROR ===");
console.log(errors.length === 0 ? "nenhum" : errors.join("\n"));
console.log("\n=== RESUMO ===");
for (const r of report) console.log(`${r.verdict.padEnd(6)} ${r.step}`);
const failed = report.some((r) => r.verdict === "FAIL") || errors.length > 0;
console.log(failed ? "VALIDATE-MEETINGS-DETECT FAILED" : "VALIDATE-MEETINGS-DETECT DONE");
process.exit(failed ? 1 : 0);
