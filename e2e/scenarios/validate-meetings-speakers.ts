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
import initSqlJs from "sql.js";
import { captureLogs, screenshot } from "../driver/capture";
import { queryDb } from "../driver/inspect";
import { launchApp, REPO_ROOT, resolveRealUserData } from "../driver/launch";
import { goToArea, waitReady } from "../driver/nav";

// Diarização com o addon REAL (sherpa-onnx) numa gravação em fixture:
// system-duas-vozes.wav (56 s, 2 vozes) na trilha them, silêncio no mic,
// STT fake local e resumo em fixture. Sem CM_MEETING_DIARIZE_FIXTURE de
// propósito — o que se prova aqui é o pipeline pyannote → TitaNet →
// clustering → speakers no banco → labels no transcript.
//
// Esperado: 2 linhas em meeting_v2_speakers e speaker_label dos segmentos
// `them` distribuído entre as duas. Com CM_MEETING_DIARIZE_DEBUG=1 o main loga
// o cosseno de cada turno contra cada centroide — é o que calibra o limiar
// (CM_MEETING_SPEAKER_THRESHOLD passa direto pro app).
//
// Pré-requisito: npm run rebuild:native && npm run build. O modelo TitaNet
// precisa estar no disco (userData/meeting-models ou o sidecar antigo em
// ~/.claude-manager); sem ele o status vem 'unavailable' e o cenário falha cedo.

const require = createRequire(import.meta.url);
const FIXTURES = join(REPO_ROOT, "e2e/fixtures/meetings");
const RECORD_MS = 60_000;
const FINISH_TIMEOUT_MS = 60_000;
const EXPECTED_SPEAKERS = 2;

async function prunedBaseProfile(): Promise<string> {
  const real = resolveRealUserData();
  const dir = mkdtempSync(join(tmpdir(), "cm-meetings-spk-base-"));
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
  for (const [key, value] of [
    ["autoPullEnabled", false],
    ["meeting_diarization", true],
  ] as const) {
    db.run("INSERT OR REPLACE INTO app_prefs (key, value) VALUES (?, ?)", [
      key,
      JSON.stringify(value),
    ]);
  }
  // Vozes conhecidas do perfil real mudariam os labels ("Ana" em vez de
  // "Participante 1"): o cenário parte de banco limpo de reuniões e vozes.
  for (const table of ["meetings_v2", "meeting_v2_voices"]) {
    try {
      db.run(`DELETE FROM ${table}`);
    } catch {
      // tabela ausente: a migração cria no boot
    }
  }
  writeFileSync(join(dir, "app.db"), Buffer.from(db.export()));
  db.close();
  return dir;
}

// Fake STT: dois segmentos por chunk, um em cada metade (1,5–5,5 s e 6,5–11 s),
// pra cada chunk render segmentos que caem em turnos diferentes.
let sttCalls = 0;
const server = createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    const n = sttCalls++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        text: `frase ${n * 2 + 1}. frase ${n * 2 + 2}.`,
        language: "pt",
        duration: 12,
        segments: [
          { id: n * 2, start: 1.5, end: 5.5, text: `frase ${n * 2 + 1}`, no_speech_prob: 0.05 },
          { id: n * 2 + 1, start: 6.5, end: 11.0, text: `frase ${n * 2 + 2}`, no_speech_prob: 0.05 },
        ],
      }),
    );
  });
});
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
console.log(`[fake-stt] ouvindo em 127.0.0.1:${port}`);

type Verdict = "PASS" | "FAIL" | "INFO";
const report: Array<{ step: string; verdict: Verdict; evidence: string }> = [];
function record(step: string, verdict: Verdict, evidence: string): void {
  report.push({ step, verdict, evidence });
  console.log(`[${verdict}] ${step} — ${evidence}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

process.env.CM_REAL_USERDATA = await prunedBaseProfile();
console.log("[perfil] base podada em", process.env.CM_REAL_USERDATA);

const summaryFixture = join(FIXTURES, "summary-fixture.json");
const systemWav = join(FIXTURES, "system-duas-vozes.wav");
const micWav = join(FIXTURES, "silence-5s.wav");
for (const f of [summaryFixture, systemWav, micWav]) {
  if (!existsSync(f)) throw new Error(`fixture ausente: ${f}`);
}

const threshold = process.env.CM_MEETING_SPEAKER_THRESHOLD ?? "(default)";
const { app, page, userDataCopy } = await launchApp({
  env: {
    VOZ_STT_URL: `http://127.0.0.1:${port}/v1/audio/transcriptions`,
    VOZ_STT_KEY: "fake",
    CM_MEETING_FIXTURE_SYSTEM: systemWav,
    CM_MEETING_FIXTURE_MIC: micWav,
    CM_MEETING_FIXTURE_PACE: "1",
    CM_MEETING_SUMMARY_FIXTURE: summaryFixture,
    // addon real: nenhuma fixture de diarização, mesmo que o shell tenha uma
    CM_MEETING_DIARIZE_FIXTURE: "",
    CM_MEETING_DIARIZE_DEBUG: "1",
  },
});
const { logFile, stop: stopLogs } = captureLogs(app, page);

const errors: string[] = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
});

interface ApiSegment {
  speaker: string;
  text: string;
  speakerId: string | null;
  speakerLabel: string | null;
}
interface ApiDetail {
  meeting: { id: string; status: string; error: string | null; diarization: string | null };
  segments: ApiSegment[];
}
interface ApiState {
  active: { id: string } | null;
  captureMode: string;
  diarization: string;
}
const apiState = () =>
  page.evaluate(() =>
    (window as unknown as { api: { meetings: { state: () => Promise<unknown> } } }).api.meetings.state(),
  ) as Promise<ApiState>;
const apiGet = (id: string) =>
  page.evaluate(
    (mid) =>
      (window as unknown as { api: { meetings: { get: (id: string) => Promise<unknown> } } }).api.meetings.get(mid),
    id,
  ) as Promise<ApiDetail>;

let meetingId: string | null = null;
let finalDetail: ApiDetail | null = null;
let stopped = false;

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
  // Diagnóstico antes do start: addon carregado + modelos no disco.
  const setup = (await page.evaluate(() =>
    (window as unknown as { api: { meetings: { checkSetup: () => Promise<unknown> } } }).api.meetings.checkSetup(),
  )) as { diarization: { supported: boolean; addon: boolean; models: Record<string, unknown> } };
  record("(0) setup da diarização", "INFO", JSON.stringify(setup.diarization));

  // --- (a) start + status da diarização ------------------------------------
  const startBtn = page.getByRole("button", { name: "Iniciar gravação" }).first();
  if (!(await startBtn.isEnabled())) {
    await screenshot(page, "speakers-00-debug-start-disabled");
    throw new Error('"Iniciar gravação" desabilitado');
  }
  await startBtn.click();
  await page.getByText(/^Gravando/).first().waitFor({ state: "visible", timeout: 15_000 });
  const state = await apiState();
  meetingId = state.active?.id ?? null;
  if (!meetingId) throw new Error("estado ativo sem reunião");

  // O worker sobe no primeiro start(): 'loading' → 'on' em alguns segundos.
  let diarization = state.diarization;
  const deadlineA = Date.now() + 30_000;
  while (diarization !== "on" && diarization !== "unavailable" && Date.now() < deadlineA) {
    await sleep(500);
    diarization = (await apiState()).diarization;
  }
  record(
    "(a) gravação iniciada com diarização ligada",
    diarization === "on" ? "PASS" : "FAIL",
    `meeting=${meetingId} captureMode=${state.captureMode} diarization=${diarization} threshold=${threshold}`,
  );
  if (diarization !== "on") throw new Error(`diarização não ligou: ${diarization}`);

  // --- (b) grava ~60 s (fixture de 56 s), acompanhando os labels ao vivo ------
  const started = Date.now();
  let lastLog = 0;
  while (Date.now() - started < RECORD_MS) {
    await sleep(2_000);
    if (Date.now() - lastLog > 10_000) {
      lastLog = Date.now();
      const d = await apiGet(meetingId);
      const labels = d.segments.filter((s) => s.speaker === "them").map((s) => s.speakerLabel ?? "∅");
      console.log(`[live +${Math.round((Date.now() - started) / 1000)}s] segmentos=${d.segments.length} labels=${labels.join(",")}`);
    }
  }
  const shotLive = await screenshot(page, "speakers-01-live-transcript");
  const live = await apiGet(meetingId);
  const liveLabels = new Set(live.segments.filter((s) => s.speaker === "them").map((s) => s.speakerLabel));
  record(
    "(b) transcript ao vivo com labels",
    liveLabels.size >= EXPECTED_SPEAKERS ? "PASS" : "FAIL",
    `${shotLive} · segmentos=${live.segments.length} labels=${[...liveLabels].join("|")}`,
  );

  // --- (c) parar → done ------------------------------------------------------
  await page.getByRole("button", { name: "Parar" }).first().click();
  stopped = true;
  const deadlineC = Date.now() + FINISH_TIMEOUT_MS;
  while (Date.now() < deadlineC) {
    const d = await apiGet(meetingId);
    if (d.meeting.status === "done" || d.meeting.status === "error") {
      finalDetail = d;
      break;
    }
    await sleep(500);
  }
  const shotDone = await screenshot(page, "speakers-02-done-transcript");
  record(
    "(c) parar → concluída",
    finalDetail?.meeting.status === "done" ? "PASS" : "FAIL",
    `${shotDone} · status=${finalDetail?.meeting.status ?? "timeout"} error=${finalDetail?.meeting.error ?? "-"} diarization=${finalDetail?.meeting.diarization}`,
  );
} catch (err) {
  console.log("[erro]", err instanceof Error ? err.message : String(err));
  await screenshot(page, "speakers-99-debug-failure").catch(() => {});
  if (!report.some((r) => r.verdict === "FAIL"))
    record("execução", "FAIL", err instanceof Error ? err.message : String(err));
} finally {
  if (meetingId && !stopped) {
    await page
      .evaluate(() =>
        (window as unknown as { api: { meetings: { stop: () => Promise<unknown> } } }).api.meetings.stop(),
      )
      .catch(() => {});
  }
  stopLogs();
  await app.close();
  server.close();
}

// --- (d) banco (após o close: queryDb não lê o WAL) ---------------------------
if (meetingId) {
  const speakers = await queryDb<{ id: string; label: string; turn_count: number; centroid_bytes: number }>(
    userDataCopy,
    `SELECT id, label, turn_count, length(centroid) AS centroid_bytes
       FROM meeting_v2_speakers WHERE meeting_id = '${meetingId}' ORDER BY rowid`,
  );
  const distribution = await queryDb<{ speaker_label: string | null; c: number }>(
    userDataCopy,
    `SELECT speaker_label, COUNT(*) AS c FROM meeting_v2_segments
      WHERE meeting_id = '${meetingId}' AND speaker = 'them'
      GROUP BY speaker_label ORDER BY c DESC`,
  );
  const labelsUsed = distribution.filter((d) => d.speaker_label !== null);
  const bothUsed = labelsUsed.length === EXPECTED_SPEAKERS && labelsUsed.every((d) => d.c > 0);
  record(
    `(d) ${EXPECTED_SPEAKERS} speakers no banco`,
    speakers.length === EXPECTED_SPEAKERS ? "PASS" : "FAIL",
    speakers.map((s) => `${s.label}(turnos=${s.turn_count}, centroide=${s.centroid_bytes}B)`).join(" · ") || "nenhum",
  );
  record(
    "(e) speaker_label distribuído entre os dois",
    bothUsed ? "PASS" : "FAIL",
    distribution.map((d) => `${d.speaker_label ?? "∅"}=${d.c}`).join(" · ") || "nenhum segmento",
  );
} else {
  record("(d)/(e) banco", "FAIL", "sem reunião");
}

await sleep(300);
const log = readFileSync(logFile, "utf8");
const sims = log.split("\n").filter((l) => l.includes("[diarizer] sim turno"));
const warns = log.split("\n").filter((l) => l.includes("[diarizer]") && !l.includes("sim turno"));
console.log(`\n=== SIMILARIDADES (${sims.length} turnos) ===`);
console.log(sims.map((l) => l.slice(l.indexOf("[diarizer]"))).join("\n") || "nenhuma (CM_MEETING_DIARIZE_DEBUG não chegou ao main?)");
console.log("\n=== AVISOS DO DIARIZER ===");
console.log(warns.map((l) => l.slice(l.indexOf("[diarizer]"))).join("\n") || "nenhum");
console.log("\n=== ERROS DE CONSOLE ===");
console.log(errors.length === 0 ? "nenhum" : errors.join("\n"));
console.log(`\nchamadas STT: ${sttCalls}`);
console.log("\n=== RESUMO ===");
for (const r of report) console.log(`${r.verdict.padEnd(6)} ${r.step}`);
console.log("log completo:", logFile);
process.exit(report.some((r) => r.verdict === "FAIL") ? 1 : 0);
