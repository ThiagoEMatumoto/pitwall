import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { captureLogs, screenshot } from "../driver/capture";
import { queryDb } from "../driver/inspect";
import { launchApp, REPO_ROOT, resolveRealUserData } from "../driver/launch";
import { goToArea, waitReady } from "../driver/nav";

// W3: detecção via PipeWire REAL (sem CM_MEETING_DETECT_SCRIPT). `arecord`
// aparece no PipeWire com client binary "aplay" (mesmo binário ALSA-plugin
// nos dois), fora da deny-list — serve de "app de chamada" real pro teste.
// Mic fixture (silence-5s.wav) evita depender do mic físico pro conteúdo;
// system track é pw-record real, alimentado por `pw-play` do fixture de
// sistema — então o transcript "them" é STT real de verdade.

const FIXTURES = join(REPO_ROOT, "e2e/fixtures/meetings");
const micWav = join(FIXTURES, "silence-5s.wav");
const systemWav = join(FIXTURES, "system-participante.wav");
for (const f of [micWav, systemWav]) {
  if (!existsSync(f)) throw new Error(`fixture ausente: ${f}`);
}

type Verdict = "PASS" | "FAIL" | "SKIP" | "INFO";
const report: Array<{ step: string; verdict: Verdict; evidence: string }> = [];
function record(step: string, verdict: Verdict, evidence: string): void {
  report.push({ step, verdict, evidence });
  console.log(`[${verdict}] ${step} — ${evidence}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function prunedBaseProfile(): string {
  const real = resolveRealUserData();
  const dir = mkdtempSync(join(tmpdir(), "cm-meetings-detect-real-base-"));
  process.once("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });
  cpSync(join(real, "app.db"), join(dir, "app.db"));
  return dir;
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
  detection: { app: string; binary: string } | null;
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
  return { apiState, apiGet };
}

let arecordProc: ChildProcess | null = null;
let pwPlayProc: ChildProcess | null = null;
function killChild(p: ChildProcess | null): void {
  // Mata só o PID do child que EU spawnei — nunca o process group do shell.
  if (p && p.pid && !p.killed) {
    try {
      process.kill(p.pid, "SIGTERM");
    } catch {
      // já morto
    }
  }
}

process.env.CM_REAL_USERDATA = prunedBaseProfile();
const { app, page, userDataCopy } = await launchApp({
  env: { CM_MEETING_FIXTURE_MIC: micWav },
});
const { logFile, stop: stopLogs } = captureLogs(app, page);
watchErrors(page, "main");
const { apiState, apiGet } = bindApi(page);

try {
  await waitReady(page);
  await goToArea(page, "meetings");

  // --- (1) arecord real dispara detecção real via pw-dump -------------------
  const t0 = Date.now();
  arecordProc = spawn("arecord", ["-f", "S16_LE", "-r", "16000", "-d", "40", "/dev/null"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let arecordStderr = "";
  arecordProc.stderr?.on("data", (d: Buffer) => (arecordStderr += d.toString()));
  arecordProc.on("exit", (code) => console.log(`[arecord] saiu code=${code} stderr=${arecordStderr.trim()}`));

  const banner = page.getByRole("status").filter({ hasText: "está usando o microfone" });
  let detectMs = -1;
  const deadline1 = Date.now() + 15_000;
  while (Date.now() < deadline1) {
    if (await banner.isVisible().catch(() => false)) {
      detectMs = Date.now() - t0;
      break;
    }
    await sleep(200);
  }
  const shot01 = await screenshot(page, "meetings-detect-real-01");
  const state1 = await apiState();
  record(
    "(1) arecord real → banner+pill em ≤8s (pw-dump real)",
    detectMs >= 0 && detectMs <= 8000 ? "PASS" : detectMs >= 0 ? "FAIL" : "FAIL",
    `${shot01} · detectMs=${detectMs} detecção=${JSON.stringify(state1.detection)}`,
  );
  if (detectMs < 0) throw new Error("FALHA (1): banner de detecção real nunca apareceu");

  // --- (2) Gravar + pw-play real → transcript real ---------------------------
  await page.getByRole("button", { name: "Gravar" }).first().click();
  const hero = page.getByText(/^Gravando/).first();
  await hero.waitFor({ state: "visible", timeout: 10_000 });
  const s = await apiState();
  const meetingId = s.active?.id ?? null;
  if (!meetingId) throw new Error("FALHA (2): Gravar não iniciou reunião");
  console.log("[meeting]", meetingId);

  pwPlayProc = spawn("pw-play", [systemWav], { stdio: ["ignore", "ignore", "pipe"] });
  let pwPlayStderr = "";
  pwPlayProc.stderr?.on("data", (d: Buffer) => (pwPlayStderr += d.toString()));
  pwPlayProc.on("exit", (code) => console.log(`[pw-play] saiu code=${code} stderr=${pwPlayStderr.trim()}`));

  // --- (3) arecord termina (40s) → auto-stop ≤20s depois ----------------------
  let sawActiveNull = false;
  let autoStopMs = -1;
  const deadline3 = Date.now() + 90_000;
  while (Date.now() < deadline3) {
    const st = await apiState();
    if (!st.active) {
      sawActiveNull = true;
      autoStopMs = Date.now() - t0;
      break;
    }
    await sleep(1_000);
  }
  const shot02 = await screenshot(page, "meetings-detect-real-02");
  record(
    "(3) auto-stop quando arecord termina (~40s + até 20s de histerese)",
    sawActiveNull ? "PASS" : "FAIL",
    `${shot02} · autoStopMs=${autoStopMs} (alvo ≤ ~60000)`,
  );

  // --- (4) status final Concluída + segmentos them > 0 -----------------------
  let finalStatus = "";
  const deadline4 = Date.now() + 60_000;
  while (Date.now() < deadline4) {
    const d = await apiGet(meetingId);
    finalStatus = d.meeting.status;
    if (finalStatus === "done" || finalStatus === "error") break;
    await sleep(1_000);
  }
  record(
    "(4) status final done/error",
    finalStatus === "done" ? "PASS" : "FAIL",
    `finalStatus=${finalStatus}`,
  );

  const segRows = await queryDb<{ speaker: string; c: number }>(
    userDataCopy,
    `SELECT speaker, COUNT(*) AS c FROM meeting_v2_segments WHERE meeting_id = '${meetingId}' GROUP BY speaker`,
  );
  const them = segRows.find((r) => r.speaker === "them")?.c ?? 0;
  record(
    "(4b) queryDb: segmentos them > 0 (STT real)",
    them > 0 ? "PASS" : "FAIL",
    `segRows=${JSON.stringify(segRows)}`,
  );

  // --- (5) negativo: gravação MANUAL não gera detecção (pw-record é próprio app, deny-listed) --
  await sleep(1_000);
  const startBtn = page.getByRole("button", { name: "Iniciar gravação" }).first();
  await startBtn.waitFor({ state: "visible", timeout: 10_000 });
  await startBtn.click();
  await page.getByText(/^Gravando/).first().waitFor({ state: "visible", timeout: 10_000 });
  let sawDetectionDuringManual = false;
  const deadline5 = Date.now() + 15_000;
  while (Date.now() < deadline5) {
    const st = await apiState();
    if (st.detection) {
      sawDetectionDuringManual = true;
      break;
    }
    await sleep(1_000);
  }
  const shot03 = await screenshot(page, "meetings-detect-real-03");
  record(
    "(5) gravação manual (pw-record próprio) NÃO dispara auto-detecção em 15s",
    !sawDetectionDuringManual ? "PASS" : "FAIL",
    `${shot03} · detectouDurantePropria=${sawDetectionDuringManual}`,
  );
  await page.getByRole("button", { name: "Parar" }).first().click();
  await sleep(1_000);
} catch (err) {
  console.log("[erro]", err instanceof Error ? err.message : String(err));
  await screenshot(page, "meetings-detect-real-99-failure").catch(() => {});
  if (!report.some((r) => r.verdict === "FAIL"))
    record("execução", "FAIL", err instanceof Error ? err.message : String(err));
} finally {
  killChild(arecordProc);
  killChild(pwPlayProc);
  try {
    const s = await apiState();
    if (s.active) {
      await page.evaluate(() =>
        (window as unknown as { api: { meetings: { stop: () => Promise<unknown> } } }).api.meetings.stop(),
      );
    }
  } catch {
    // app já morto
  }
  stopLogs();
  await app.close();
}

console.log("\n=== ERROS DE CONSOLE/PAGEERROR ===");
console.log(errors.length === 0 ? "nenhum" : errors.join("\n"));
console.log("\n=== RESUMO ===");
for (const r of report) console.log(`${r.verdict.padEnd(6)} ${r.step}`);
console.log("log:", logFile);
const failed = report.some((r) => r.verdict === "FAIL") || errors.length > 0;
console.log(failed ? "VALIDATE-MEETINGS-DETECT-REAL FAILED" : "VALIDATE-MEETINGS-DETECT-REAL DONE");
process.exit(failed ? 1 : 0);
