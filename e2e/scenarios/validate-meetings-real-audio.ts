import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "playwright";
import { captureLogs, screenshot } from "../driver/capture";
import { queryDb } from "../driver/inspect";
import { launchApp, REPO_ROOT } from "../driver/launch";
import { goToArea, waitReady } from "../driver/nav";

// Teste REAL de Reuniões v2: mic em fixture de silêncio (não há voz na sala),
// captura do SISTEMA via pw-record de verdade (sem CM_MEETING_FIXTURE_SYSTEM),
// STT real (config de ~/.config/voz/voz.env, sem override), e resumo real via
// `claude -p` (sem CM_MEETING_SUMMARY_FIXTURE). O "participante remoto" é
// simulado tocando o WAV de fixture no sink default com `pw-play`.
//
// system-duas-vozes.wav (56,18s) é a concatenação byte-a-byte de
// system-participante.wav (Keren, 38,24s) + mic-eu.wav (Flavio, 17,94s) —
// confirmado por diff de PCM. O transcript esperado pra similaridade é a
// concatenação dos dois campos `transcript` do manifest, na mesma ordem.

const execFileAsync = promisify(execFile);
const FIXTURES = join(REPO_ROOT, "e2e/fixtures/meetings");
const SILENCE_WAV = join(FIXTURES, "silence-5s.wav");
const SYSTEM_WAV = join(FIXTURES, "system-duas-vozes.wav");
const MANIFEST_PATH = join(FIXTURES, "manifest.json");
const SEGMENTS_WANTED = 5;
const TRANSCRIPT_TIMEOUT_MS = 120_000;
const FINISH_TIMEOUT_MS = 240_000;

for (const f of [SILENCE_WAV, SYSTEM_WAV, MANIFEST_PATH]) {
  if (!existsSync(f)) throw new Error(`fixture ausente: ${f}`);
}

interface ManifestEntry {
  file: string;
  transcript: string;
}
const manifest = JSON.parse(
  readFileSync(MANIFEST_PATH, "utf8"),
) as ManifestEntry[];
// system-duas-vozes.wav = system-participante.wav + mic-eu.wav concatenados
// (verificado por diff de PCM) — o texto esperado é a soma dos dois.
const partEntry = manifest.find((m) => m.file === "system-participante.wav");
const micEntry = manifest.find((m) => m.file === "mic-eu.wav");
if (!partEntry) throw new Error("manifest sem entrada system-participante.wav");
if (!micEntry) throw new Error("manifest sem entrada mic-eu.wav");
const expectedTranscript = `${partEntry.transcript} ${micEntry.transcript}`;
const expectedWords = expectedTranscript
  .toLowerCase()
  .replace(/[.,!?]/g, "")
  .split(/\s+/)
  .filter((w) => w.length > 2); // ignora stopwords curtas ("a", "o", "de"...)

type Verdict = "PASS" | "FAIL" | "SKIP" | "INFO";
const report: Array<{ step: string; verdict: Verdict; evidence: string }> = [];
function record(step: string, verdict: Verdict, evidence: string): void {
  report.push({ step, verdict, evidence });
  console.log(`[${verdict}] ${step} — ${evidence}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- descobrir o sink default via wpctl -------------------------------------
async function defaultSinkNodeName(): Promise<string> {
  const { stdout } = await execFileAsync("wpctl", ["status"]);
  const m = stdout.match(/Default Configured Devices:\s*\n\s*\d+\.\s*Audio\/Sink\s+(\S+)/);
  if (!m) throw new Error(`não consegui achar o sink default em wpctl status:\n${stdout}`);
  return m[1];
}

async function defaultSinkVolume(): Promise<number> {
  const { stdout } = await execFileAsync("wpctl", ["get-volume", "@DEFAULT_AUDIO_SINK@"]);
  const m = stdout.match(/Volume:\s*([\d.]+)/);
  return m ? Number(m[1]) : NaN;
}

const sinkNodeName = await defaultSinkNodeName();
console.log("[audio] sink default:", sinkNodeName);
let vol = await defaultSinkVolume();
console.log("[audio] volume do sink:", vol);
let volumeAdjusted = false;
if (!(vol > 0.05)) {
  await execFileAsync("wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", "0.5"]);
  volumeAdjusted = true;
  vol = await defaultSinkVolume();
  console.log("[audio] volume ajustado para:", vol);
}

// --- subir o app -------------------------------------------------------------
const { app, page, userDataCopy } = await launchApp({
  env: {
    CM_MEETING_FIXTURE_MIC: SILENCE_WAV,
    CM_MEETING_FIXTURE_PACE: "1",
    // Sem CM_MEETING_FIXTURE_SYSTEM: captura real via pw-record.
    // Sem VOZ_STT_URL/VOZ_STT_KEY: config real de ~/.config/voz/voz.env.
    // Sem CM_MEETING_SUMMARY_FIXTURE: resumo real via `claude -p`.
  },
});
const { logFile, stop: stopLogs } = captureLogs(app, page);

const errors: string[] = [];
function watchErrors(p: Page, tag: string): void {
  p.on("pageerror", (e) => errors.push(`${tag} pageerror: ${e.message}`));
  p.on("console", (m) => {
    if (m.type() === "error") errors.push(`${tag} console.error: ${m.text()}`);
  });
}
watchErrors(page, "main");

interface ApiMeeting {
  id: string;
  status: string;
  summaryMd: string | null;
  error: string | null;
}
interface ApiDetail {
  meeting: ApiMeeting;
  segments: Array<{ speaker: string; text: string }>;
  actionItems: Array<{ title: string; quote: string | null; status: string }>;
}
const apiState = () =>
  page.evaluate(() =>
    (window as unknown as { api: { meetings: { state: () => Promise<unknown> } } }).api.meetings.state(),
  ) as Promise<{ active: ApiMeeting | null; captureMode: string }>;
const apiGet = (id: string) =>
  page.evaluate(
    (mid) => (window as unknown as { api: { meetings: { get: (id: string) => Promise<unknown> } } }).api.meetings.get(mid),
    id,
  ) as Promise<ApiDetail>;

let meetingId: string | null = null;
let finalDetail: ApiDetail | null = null;
let firstSegmentLatencyMs: number | null = null;
let pwPlayStderr = "";

try {
  await waitReady(page);
  await app
    .evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win && win.getBounds().width < 1400) win.setSize(1400, 900);
    })
    .catch(() => {});

  await goToArea(page, "meetings");
  await page.getByRole("heading", { name: "Reuniões" }).waitFor({ state: "visible", timeout: 10_000 });

  // --- (1) Iniciar gravação -----------------------------------------------
  const startBtn = page.getByRole("button", { name: "Iniciar gravação" }).first();
  const startEnabled = await startBtn.isEnabled();
  if (!startEnabled) {
    await screenshot(page, "meetings-real-00-debug-start-disabled");
    throw new Error('"Iniciar gravação" desabilitado');
  }
  await startBtn.click();
  await page.getByText(/^Gravando/).first().waitFor({ state: "visible", timeout: 15_000 });
  const state = await apiState();
  meetingId = state.active?.id ?? null;
  if (!meetingId) throw new Error("estado ativo sem reunião após start");
  record(
    "(1) Iniciar gravação → Gravando",
    state.captureMode === "pipewire" ? "PASS" : "FAIL",
    `meeting=${meetingId} captureMode=${state.captureMode} (esperado pipewire — mic é fixture mas captureMode reflete a trilha 'them')`,
  );

  // --- (2) tocar o WAV no sink default via pw-play --------------------------
  await sleep(1500); // dar tempo do pw-record real subir antes do pw-play
  const playStart = Date.now();
  console.log(`[pw-play] tocando ${SYSTEM_WAV} em --target ${sinkNodeName}`);
  const playPromise = execFileAsync("pw-play", ["--target", sinkNodeName, SYSTEM_WAV]).catch((err) => {
    pwPlayStderr = (err as { stderr?: string }).stderr ?? String(err);
    return { stdout: "", stderr: pwPlayStderr };
  });

  // --- (3) esperar ≥3 segmentos "them" --------------------------------------
  let themCount = 0;
  const deadline = Date.now() + TRANSCRIPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const d = await apiGet(meetingId);
    themCount = d.segments.filter((s) => s.speaker === "them").length;
    if (themCount > 0 && firstSegmentLatencyMs === null) {
      firstSegmentLatencyMs = Date.now() - playStart;
    }
    if (themCount >= SEGMENTS_WANTED) break;
    await sleep(1_000);
  }
  const result = await playPromise;
  if (result.stderr) pwPlayStderr = result.stderr;
  await sleep(3_000);
  const shot01 = await screenshot(page, "meetings-real-01-transcript");
  const liveState = await apiState();
  record(
    `(3) ≥${SEGMENTS_WANTED} segmentos "them" reais`,
    themCount >= SEGMENTS_WANTED ? "PASS" : "FAIL",
    `${shot01} · segmentos_them=${themCount} latência_1º_segmento=${firstSegmentLatencyMs}ms sttOk=${(liveState as { sttOk?: boolean }).sttOk} lastError=${(liveState as { lastError?: string }).lastError ?? "null"} pwPlayStderr=${pwPlayStderr || "none"}`,
  );
  if (themCount === 0) {
    throw new Error(
      `nenhum segmento 'them' em ${TRANSCRIPT_TIMEOUT_MS / 1000}s — ver diagnóstico manual no relatório final`,
    );
  }

  // --- (4) Parar → Concluída -------------------------------------------------
  await page.getByRole("button", { name: "Parar" }).first().click();
  let finalStatus = "";
  const deadlineStop = Date.now() + FINISH_TIMEOUT_MS;
  while (Date.now() < deadlineStop) {
    const d = await apiGet(meetingId);
    finalStatus = d.meeting.status;
    if (finalStatus === "done" || finalStatus === "error") {
      finalDetail = d;
      break;
    }
    await sleep(1_000);
  }
  const concludedVisible = await page
    .getByText(finalStatus === "done" ? "Concluída" : "Erro", { exact: true })
    .first()
    .isVisible()
    .catch(() => false);
  const shot02 = await screenshot(page, "meetings-real-02-summary");
  record(
    "(4) Parar → Concluída",
    finalStatus === "done" && concludedVisible ? "PASS" : "FAIL",
    `${shot02} · status=${finalStatus} label_visível=${concludedVisible} erro=${finalDetail?.meeting.error ?? "null"}`,
  );
} catch (err) {
  console.log("[erro]", err instanceof Error ? err.message : String(err));
  await screenshot(page, "meetings-real-99-debug-failure").catch(() => {});
  if (!report.some((r) => r.verdict === "FAIL"))
    record("execução", "FAIL", err instanceof Error ? err.message : String(err));
} finally {
  try {
    const s = await apiState();
    if (s.active) {
      await page.evaluate(() =>
        (window as unknown as { api: { meetings: { stop: () => Promise<unknown> } } }).api.meetings.stop(),
      );
      await sleep(1_000);
    }
  } catch {
    // app já morto
  }
  stopLogs();
  await app.close();
}

// --- (5) banco -----------------------------------------------------------
if (meetingId) {
  const meetings = await queryDb<{ status: string; summary_md: string | null }>(
    userDataCopy,
    `SELECT status, summary_md FROM meetings_v2 WHERE id = '${meetingId}'`,
  );
  const themSegments = await queryDb<{ text: string }>(
    userDataCopy,
    `SELECT text FROM meeting_v2_segments WHERE meeting_id = '${meetingId}' AND speaker = 'them' ORDER BY start_ms`,
  );
  const meSegments = await queryDb<{ text: string }>(
    userDataCopy,
    `SELECT text FROM meeting_v2_segments WHERE meeting_id = '${meetingId}' AND speaker = 'me' ORDER BY start_ms`,
  );
  const items = await queryDb<{
    title: string;
    quote: string | null;
    status: string;
    owner: string | null;
    owner_kind: string;
    task_id: string | null;
  }>(
    userDataCopy,
    `SELECT title, quote, status, owner, owner_kind, task_id FROM meeting_v2_action_items WHERE meeting_id = '${meetingId}' ORDER BY created_at, rowid`,
  );
  const speakers = await queryDb<{ id: string; label: string }>(
    userDataCopy,
    `SELECT id, label FROM meeting_v2_speakers WHERE meeting_id = '${meetingId}' ORDER BY rowid`,
  );
  const taskIds = items.map((i) => i.task_id).filter((id): id is string => !!id);
  const autoTasks = taskIds.length
    ? await queryDb<{ id: string; origin: string }>(
        userDataCopy,
        `SELECT id, origin FROM tasks WHERE id IN (${taskIds.map((id) => `'${id}'`).join(",") || "''"}) AND origin = 'auto'`,
      )
    : [];

  const themText = themSegments.map((s) => s.text).join(" ");
  const themWords = new Set(
    themText.toLowerCase().replace(/[.,!?]/g, "").split(/\s+/).filter(Boolean),
  );
  const matched = expectedWords.filter((w) => themWords.has(w));
  const similarity = expectedWords.length ? matched.length / expectedWords.length : 0;

  record(
    "(5a) meetings_v2 status + summary_md",
    meetings[0]?.status === "done" && !!meetings[0]?.summary_md ? "PASS" : "FAIL",
    `status=${meetings[0]?.status} summary_md=${meetings[0]?.summary_md ? `${meetings[0].summary_md.length} chars` : "NULL"}`,
  );
  record(
    "(5b) transcript 'them' vs manifest (similaridade de palavras)",
    similarity >= 0.5 ? "PASS" : "FAIL",
    `similaridade=${(similarity * 100).toFixed(1)}% (${matched.length}/${expectedWords.length} palavras) · texto="${themText.slice(0, 200)}${themText.length > 200 ? "…" : ""}"`,
  );
  record(
    "(5c) segmentos 'me' (esperado 0 ou lixo curto — mic é silêncio)",
    meSegments.length === 0 || meSegments.every((s) => s.text.trim().length < 20) ? "PASS" : "FAIL",
    JSON.stringify(meSegments.map((s) => s.text)),
  );
  record(
    "(5d) action items extraídos pelo resumo real",
    "INFO",
    items.length ? JSON.stringify(items) : "nenhum action item extraído",
  );
  record(
    "(5e) ≥2 speakers em meeting_v2_speakers",
    speakers.length >= 2 ? "PASS" : "FAIL",
    speakers.map((s) => s.label).join(" · ") || "nenhum speaker",
  );
  const summaryMd = meetings[0]?.summary_md ?? "";
  const hasParticipantes = summaryMd.includes("## Participantes");
  const hasProximasEtapas = summaryMd.includes("## Próximas etapas");
  const hasOwnerBracket = /\[[^\]]+\]/.test(summaryMd);
  record(
    "(5f) summary_md tem estrutura Gemini (Participantes/Próximas etapas/dono)",
    hasParticipantes && hasProximasEtapas && hasOwnerBracket ? "PASS" : "FAIL",
    `participantes=${hasParticipantes} proximas_etapas=${hasProximasEtapas} owner_bracket=${hasOwnerBracket}`,
  );
  const allProposed = items.length > 0 && items.every((i) => i.status === "proposed");
  const withOwner = items.filter((i) => i.owner && i.owner.trim().length > 0);
  record(
    "(5g) action items todos 'proposed' com owner em ≥1",
    allProposed && withOwner.length >= 1 ? "PASS" : "FAIL",
    items.map((i) => `${i.title} status=${i.status} owner=${i.owner ?? "∅"}(${i.owner_kind})`).join(" | ") || "nenhum item",
  );
  record(
    "(5h) 0 tasks origin=auto entre as criadas pelos action items",
    autoTasks.length === 0 ? "PASS" : "FAIL",
    autoTasks.length ? JSON.stringify(autoTasks) : `nenhuma task criada ainda (task_ids=${taskIds.length})`,
  );
  if (meetings[0]?.summary_md) {
    console.log("\n=== summary_md (primeiros 1200 chars) ===");
    console.log(meetings[0].summary_md.slice(0, 1200));
  }
} else {
  record("(5) banco", "SKIP", "pulado — reunião nunca foi criada");
}

// --- diagnóstico extra se não houve segmento 'them' -------------------------
const log = readFileSync(logFile, "utf8");
const meetingsLines = log.split("\n").filter((l) => l.includes("[meetings]"));
console.log("\n=== log do main ([meetings]) ===");
console.log(meetingsLines.length ? meetingsLines.join("\n") : "nenhuma linha [meetings]");

const unexpected = errors;
record(
  "console limpo",
  unexpected.length === 0 ? "PASS" : "FAIL",
  `${errors.length} erro(s) capturado(s): ${errors.slice(0, 5).join(" | ")}`,
);

console.log("\n=== RESUMO ===");
for (const r of report) console.log(`${r.verdict.padEnd(8)} ${r.step} — ${r.evidence}`);
console.log("\nsink:", sinkNodeName, "volume:", vol, "ajustado:", volumeAdjusted);
console.log("log completo:", logFile);
const failed = report.some((r) => r.verdict === "FAIL");
console.log(failed ? "VALIDATE-MEETINGS-REAL-AUDIO FAILED" : "VALIDATE-MEETINGS-REAL-AUDIO DONE");
process.exit(failed ? 1 : 0);
