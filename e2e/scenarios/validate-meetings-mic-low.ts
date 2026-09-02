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

// Aviso de mic baixo em gravação ao vivo: mic-eu.wav atenuado −35dB
// (MIC_LOW_DBFS = −40, ver recorder.ts) força micWarning sem depender de
// hardware real. O que importa não é a transcrição em si (o fake STT
// responde qualquer chunk), e sim que o chunk atenuado CHEGA ao STT
// (contagem de chamadas) e que o gravador reporta o nível medido.

const require = createRequire(import.meta.url);
const FIXTURES = join(REPO_ROOT, "e2e/fixtures/meetings");
const MIC_LOW_WAV = join(
  "/tmp/claude-1000/-home-thiagoematumoto-projetos-pessoal-claude-manager/f56b04dc-b193-4111-bdeb-f6d59cff3619/scratchpad",
  "mic-low.wav",
);

type Verdict = "PASS" | "FAIL" | "SKIP" | "INFO";
const report: Array<{ step: string; verdict: Verdict; evidence: string }> = [];
function record(step: string, verdict: Verdict, evidence: string): void {
  report.push({ step, verdict, evidence });
  console.log(`[${verdict}] ${step} — ${evidence}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function prunedBaseProfile(): Promise<string> {
  const real = resolveRealUserData();
  const dir = mkdtempSync(join(tmpdir(), "cm-meetings-miclow-base-"));
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
  writeFileSync(join(dir, "app.db"), Buffer.from(db.export()));
  db.close();
  return dir;
}

// --- fake STT: rotaciona frases do manifest (mesmo esquema do detect.ts) ---
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
const silenceWav = join(FIXTURES, "silence-5s.wav");
for (const f of [summaryFixture, silenceWav, MIC_LOW_WAV]) {
  if (!existsSync(f)) throw new Error(`fixture ausente: ${f}`);
}

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
interface ApiLiveState {
  active: ApiMeeting | null;
  micWarning: { dbfs: number; source: string } | null;
}
function bindApi(page: Page) {
  const apiState = () =>
    page.evaluate(() =>
      (window as unknown as { api: { meetings: { state: () => Promise<unknown> } } }).api.meetings.state(),
    ) as Promise<ApiLiveState>;
  return { apiState };
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

console.log("\n=== MIC BAIXO: gravar com mic-low.wav (−35dB) ===");
process.env.CM_REAL_USERDATA = await prunedBaseProfile();
const { app, page, userDataCopy } = await launchApp({
  env: {
    VOZ_STT_URL: `http://127.0.0.1:${port}/v1/audio/transcriptions`,
    VOZ_STT_KEY: "fake",
    CM_MEETING_FIXTURE_SYSTEM: silenceWav,
    CM_MEETING_FIXTURE_MIC: MIC_LOW_WAV,
    CM_MEETING_FIXTURE_PACE: "1",
    CM_MEETING_SUMMARY_FIXTURE: summaryFixture,
  },
});
const { logFile, stop: stopLogs } = captureLogs(app, page);
watchErrors(page, "mic-low");
const { apiState } = bindApi(page);
let meetingId: string | null = null;
try {
  await waitReady(page);
  await goToArea(page, "meetings");

  // --- iniciar gravação manual --------------------------------------------
  await page.getByRole("button", { name: "Iniciar gravação" }).first().click();
  const hero = page.getByText(/^Gravando/).first();
  await hero.waitFor({ state: "visible", timeout: 10_000 });
  const s0 = await apiState();
  meetingId = s0.active?.id ?? null;
  if (!meetingId) throw new Error("FALHA: clicou Gravar mas não há reunião ativa");

  // --- (a) banner "Microfone muito baixo" em ≤15s -------------------------
  const banner = page.getByRole("alert").filter({ hasText: "Microfone muito baixo" });
  let warnMs = -1;
  const t0 = Date.now();
  const deadlineA = Date.now() + 15_000;
  while (Date.now() < deadlineA) {
    if (await banner.isVisible().catch(() => false)) {
      warnMs = Date.now() - t0;
      break;
    }
    await sleep(200);
  }
  const shot01 = await screenshot(page, "mic-low-01");
  record(
    "(a) banner 'Microfone muito baixo' em ≤15s",
    warnMs >= 0 && warnMs <= 15_000 ? "PASS" : "FAIL",
    `${shot01} · warnMs=${warnMs}`,
  );

  // --- (b) pill "· mic baixo" ----------------------------------------------
  const pillLow = page.getByRole("button", { name: /Gravando \d\d:\d\d · mic baixo/ });
  const pillLowVisible = await pillLow
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  record(
    "(b) pill com '· mic baixo'",
    pillLowVisible ? "PASS" : "FAIL",
    `pillVisível=${pillLowVisible}`,
  );

  // --- (c) copiar comando (botão presente e clicável) -----------------------
  const copyBtn = page.getByRole("button", { name: /copiar comando/i });
  const copyBtnVisible = await copyBtn.isVisible().catch(() => false);
  if (copyBtnVisible) await copyBtn.click().catch(() => {});
  record(
    "(c) botão 'Copiar comando' presente no banner",
    copyBtnVisible ? "PASS" : "FAIL",
    `visível=${copyBtnVisible}`,
  );

  // --- (d) chunk baixo ainda chega ao STT (≥1 chamada) ----------------------
  const deadlineD = Date.now() + 30_000;
  while (Date.now() < deadlineD && sttCalls.length < 1) {
    await sleep(1_000);
  }
  record(
    "(d) chunk atenuado chega ao STT (normalizado)",
    sttCalls.length >= 1 ? "PASS" : "FAIL",
    `chamadasSTT=${sttCalls.length}`,
  );

  // --- parar gravação --------------------------------------------------------
  await page.evaluate(() =>
    (window as unknown as { api: { meetings: { stop: () => Promise<unknown> } } }).api.meetings.stop(),
  );
  await sleep(1_000);
} catch (err) {
  console.log("[erro]", err instanceof Error ? err.message : String(err));
  await screenshot(page, "mic-low-99-failure").catch(() => {});
  if (!report.some((r) => r.verdict === "FAIL"))
    record("execução", "FAIL", err instanceof Error ? err.message : String(err));
} finally {
  await stopIfActive(page);
  stopLogs();
  await app.close();
}

// --- (e) banco: mic_level_dbfs < -40, ≥1 segmento 'me' ----------------------
if (meetingId) {
  const meetings = await queryDb<{ mic_level_dbfs: number | null }>(
    userDataCopy,
    `SELECT mic_level_dbfs FROM meetings_v2 WHERE id = '${meetingId}'`,
  );
  const meSegRows = await queryDb<{ c: number }>(
    userDataCopy,
    `SELECT COUNT(*) AS c FROM meeting_v2_segments WHERE meeting_id = '${meetingId}' AND speaker = 'me'`,
  );
  const dbfs = meetings[0]?.mic_level_dbfs ?? null;
  const meSegCount = meSegRows[0]?.c ?? 0;
  record(
    "(e) queryDb: mic_level_dbfs não nulo e < -40, segmentos 'me' ≥ 1",
    dbfs !== null && dbfs < -40 && meSegCount >= 1 ? "PASS" : "FAIL",
    `mic_level_dbfs=${dbfs} segmentosMe=${meSegCount}`,
  );
} else {
  record("(e) queryDb", "SKIP", "sem meetingId — cenário falhou antes de gravar");
}
console.log("log:", logFile);
server.close();

console.log("\n=== FAKE STT: chamadas ===");
console.log(sttCalls.length ? sttCalls.join("\n") : "nenhuma");
console.log("\n=== ERROS DE CONSOLE/PAGEERROR ===");
console.log(errors.length === 0 ? "nenhum" : errors.join("\n"));
console.log("\n=== RESUMO ===");
for (const r of report) console.log(`${r.verdict.padEnd(6)} ${r.step}`);
const failed = report.some((r) => r.verdict === "FAIL") || errors.length > 0;
console.log(failed ? "VALIDATE-MEETINGS-MIC-LOW FAILED" : "VALIDATE-MEETINGS-MIC-LOW DONE");
process.exit(failed ? 1 : 0);
