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

// Reuniões v2 de ponta a ponta, sem PipeWire real, sem rede e sem Claude:
// 1. CM_MEETING_FIXTURE_{SYSTEM,MIC} trocam o pw-record por dois WAVs (audio-capture.ts);
// 2. fake STT HTTP local responde verbose_json com `segments[]` — a N-ésima
//    chamada devolve a N-ésima frase do manifest (rotaciona), seja qual for a trilha;
// 3. CM_MEETING_SUMMARY_FIXTURE troca a chamada ao Claude do pós-processamento
//    (W2-A) por um JSON fixo com resumo + 2 tarefas (1 com quote real → created,
//    1 com quote inventada → proposed).
//
// Não testa o globalShortcut (não funciona no harness). O Tray só loga em caso
// de FALHA ('[meetings] tray indisponível'), então a criação é inferida pela
// ausência do warn.
//
// Perfil-base PODADO como no validate-voice: só o app.db real, layout do
// workspace zerado, autoPull desligado e sem reuniões v2 pré-existentes.

const require = createRequire(import.meta.url);
const FIXTURES = join(REPO_ROOT, "e2e/fixtures/meetings");
const SEGMENTS_WANTED = 3;
const FINISH_TIMEOUT_MS = 60_000;
const MAIN_NOTE = "Decidimos migrar o banco depois da release";
const FLOATING_NOTE = "Nota rápida pela janela flutuante";
const GROUNDED_QUOTE =
  "O Thiago vai revisar o pull request de autenticação até quinta-feira.";
// Erros de console conhecidos e não relacionados à feature — vazios por
// enquanto: qualquer pageerror/console.error derruba o cenário.
const KNOWN_ERROR_PATTERNS: RegExp[] = [];

async function prunedBaseProfile(): Promise<string> {
  const real = resolveRealUserData();
  const dir = mkdtempSync(join(tmpdir(), "cm-meetings-base-"));
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
  // O perfil real pode já ter reuniões v2 (a tabela nasce na migração 045;
  // fora desta branch ela ainda não existe) — o passo (a) exige área vazia.
  try {
    db.run("DELETE FROM meetings_v2");
  } catch {
    // tabela ausente: a migração cria no boot
  }
  writeFileSync(join(dir, "app.db"), Buffer.from(db.export()));
  db.close();
  return dir;
}

// ---------------------------------------------------------------------------
// Fake STT: rotaciona as frases do manifest, uma por chamada.
// ---------------------------------------------------------------------------
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
if (!phrases.includes(GROUNDED_QUOTE))
  throw new Error(
    `manifest sem a frase da quote ancorada: "${GROUNDED_QUOTE}"`,
  );

const sttCalls: string[] = [];
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const n = sttCalls.length;
    const phrase = phrases[n % phrases.length];
    sttCalls.push(
      `#${n + 1} ${req.method} ${req.url} body=${Buffer.concat(chunks).length}B → "${phrase.slice(0, 40)}…"`,
    );
    // start > 1 s: o gravador descarta segmento que termina dentro do overlap
    // de 1 s dos chunks seguintes (recorder.ts OVERLAP_MS).
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        text: phrase,
        language: "pt",
        duration: 12,
        segments: [
          {
            id: n,
            start: 1.5,
            end: 6.0,
            text: phrase,
            no_speech_prob: 0.05,
          },
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
console.log(
  `[fake-stt] ouvindo em 127.0.0.1:${port} (${phrases.length} frases)`,
);

// ---------------------------------------------------------------------------
// Relatório por passo
// ---------------------------------------------------------------------------
type Verdict = "PASS" | "FAIL" | "PENDENTE" | "SKIP" | "INFO";
const report: Array<{ step: string; verdict: Verdict; evidence: string }> = [];
function record(step: string, verdict: Verdict, evidence: string): void {
  report.push({ step, verdict, evidence });
  console.log(`[${verdict}] ${step} — ${evidence}`);
}

class PendingW2A extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

process.env.CM_REAL_USERDATA = await prunedBaseProfile();
console.log("[perfil] base podada em", process.env.CM_REAL_USERDATA);

const summaryFixture = join(FIXTURES, "summary-fixture.json");
const systemWav = join(FIXTURES, "system-participante.wav");
const micWav = join(FIXTURES, "mic-eu.wav");
const diarizeFixture = join(FIXTURES, "diarize-ab.json");
for (const f of [summaryFixture, systemWav, micWav, diarizeFixture]) {
  if (!existsSync(f)) throw new Error(`fixture ausente: ${f}`);
}

const { app, page, userDataCopy } = await launchApp({
  env: {
    VOZ_STT_URL: `http://127.0.0.1:${port}/v1/audio/transcriptions`,
    VOZ_STT_KEY: "fake",
    CM_MEETING_FIXTURE_SYSTEM: systemWav,
    CM_MEETING_FIXTURE_MIC: micWav,
    CM_MEETING_FIXTURE_PACE: "1",
    CM_MEETING_SUMMARY_FIXTURE: summaryFixture,
    CM_MEETING_DIARIZE_FIXTURE: diarizeFixture,
    CM_MEETING_DIARIZE_DEBUG: "1",
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

// Leitura pelo IPC do app (enxerga o WAL; queryDb só depois do close).
interface ApiMeeting {
  id: string;
  status: string;
  rawNotes: string;
  summaryMd: string | null;
  error: string | null;
}
interface ApiDetail {
  meeting: ApiMeeting;
  segments: Array<{ speaker: string; text: string; speakerId: string | null; speakerLabel: string | null }>;
  actionItems: Array<{
    title: string;
    quote: string | null;
    grounded: boolean;
    status: string;
    taskId: string | null;
  }>;
}
const apiState = () =>
  page.evaluate(() =>
    (
      window as unknown as {
        api: { meetings: { state: () => Promise<unknown> } };
      }
    ).api.meetings.state(),
  ) as Promise<{ active: ApiMeeting | null; captureMode: string }>;
const apiGet = (id: string) =>
  page.evaluate(
    (mid) =>
      (
        window as unknown as {
          api: { meetings: { get: (id: string) => Promise<unknown> } };
        }
      ).api.meetings.get(mid),
    id,
  ) as Promise<ApiDetail>;

let meetingId: string | null = null;
let floating: Page | null = null;
let finalDetail: ApiDetail | null = null;

try {
  await waitReady(page);
  // Best-effort: o canal app.evaluate (inspector do main) já morreu com
  // "Execution context was destroyed" logo após o boot neste harness; a área
  // de Reuniões não depende do tier de largura, então não é fatal.
  await app
    .evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win && win.getBounds().width < 1400) win.setSize(1400, 900);
    })
    .catch((err) => console.log("[janela] setSize ignorado:", String(err).split("\n")[0]));

  // --- (a) área Reuniões vazia --------------------------------------------
  await goToArea(page, "meetings");
  await page
    .getByRole("heading", { name: "Reuniões" })
    .waitFor({ state: "visible", timeout: 10_000 });
  const emptyVisible = await page
    .getByText("Nenhuma reunião ainda")
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  const banner = page.getByRole("alert").first();
  const bannerText = (await banner.count())
    ? await banner.innerText().catch(() => "")
    : "";
  const shot01 = await screenshot(page, "meetings-01-empty");
  if (bannerText)
    console.log("[setup-banner]", bannerText.replace(/\n/g, " | "));
  record(
    "(a) área Reuniões vazia",
    emptyVisible ? "PASS" : "FAIL",
    `${shot01}${bannerText ? ` · banner: ${bannerText.replace(/\n/g, " | ")}` : ""}`,
  );

  // --- (b) Iniciar gravação → hero "Gravando" ------------------------------
  const startBtn = page
    .getByRole("button", { name: "Iniciar gravação" })
    .first();
  const startEnabled = await startBtn.isEnabled();
  if (!startEnabled) {
    const reason = await startBtn
      .locator("xpath=..")
      .getAttribute("title")
      .catch(() => null);
    await screenshot(page, "meetings-02-debug-start-disabled");
    throw new Error(
      `FALHA (b): "Iniciar gravação" desabilitado antes do start — motivo: ${reason}`,
    );
  }
  await startBtn.click();
  const hero = page.getByText(/^Gravando/).first();
  await hero.waitFor({ state: "visible", timeout: 15_000 });
  const state = await apiState();
  meetingId = state.active?.id ?? null;
  const shot02 = await screenshot(page, "meetings-02-recording");
  if (!meetingId) throw new Error("FALHA (b): estado ativo sem reunião");
  record(
    "(b) Iniciar gravação → Gravando",
    state.captureMode === "fixture" ? "PASS" : "FAIL",
    `${shot02} · meeting=${meetingId} captureMode=${state.captureMode}`,
  );

  // --- (b2) diarização liga (worker sherpa-onnx + fixture ABAB) ------------
  let diarizationOn = (state as unknown as { diarization?: string }).diarization;
  const deadlineB2 = Date.now() + 30_000;
  while (diarizationOn !== "on" && diarizationOn !== "unavailable" && Date.now() < deadlineB2) {
    await sleep(500);
    diarizationOn = ((await apiState()) as unknown as { diarization?: string }).diarization;
  }
  record(
    "(b2) diarização ligada",
    diarizationOn === "on" ? "PASS" : "FAIL",
    `diarization=${diarizationOn}`,
  );

  // --- (j) pill "Gravando" na barra superior, fora da área -----------------
  await goToArea(page, "tasks");
  const pill = page.getByRole("button", { name: /Gravando \d\d:\d\d/ });
  const pillVisible = await pill
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  const pillTitle = pillVisible ? await pill.getAttribute("title") : null;
  const shot08 = await screenshot(page, "meetings-08-pill-other-area");
  record(
    "(j) pill Gravando visível em outra área",
    pillVisible ? "PASS" : "FAIL",
    `${shot08} · visível=${pillVisible} title=${pillTitle}`,
  );
  await goToArea(page, "meetings");
  await page
    .getByText(/^Gravando/)
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });

  // --- (c) ≥3 segmentos no transcript ---------------------------------------
  let segCount = 0;
  const deadlineC = Date.now() + 60_000;
  while (Date.now() < deadlineC) {
    const d = await apiGet(meetingId);
    segCount = d.segments.length;
    if (segCount >= SEGMENTS_WANTED) break;
    await sleep(1_000);
  }
  // DOM: a primeira frase precisa estar renderizada no transcript ao vivo.
  const firstPhraseInDom = await page
    .getByText(phrases[0], { exact: true })
    .first()
    .isVisible()
    .catch(() => false);
  const shot03 = await screenshot(page, "meetings-03-transcript");
  const liveState = await apiState();
  record(
    `(c) ≥${SEGMENTS_WANTED} segmentos ao vivo`,
    segCount >= SEGMENTS_WANTED && firstPhraseInDom ? "PASS" : "FAIL",
    `${shot03} · segmentos=${segCount} chamadasSTT=${sttCalls.length} frase#1 no DOM=${firstPhraseInDom}` +
      (liveState && !(liveState as { sttOk?: boolean }).sttOk
        ? ` · sttOk=false lastError=${(liveState as { lastError?: string }).lastError}`
        : ""),
  );
  if (segCount < SEGMENTS_WANTED)
    throw new Error(`FALHA (c): só ${segCount} segmentos em 60 s`);

  // --- (d) janela flutuante --------------------------------------------------
  const deadlineD = Date.now() + 10_000;
  while (!floating && Date.now() < deadlineD) {
    floating =
      app.windows().find((w) => w.url().endsWith("floating.html")) ?? null;
    if (!floating) await sleep(300);
  }
  if (!floating) {
    const urls = app.windows().map((w) => w.url());
    throw new Error(
      `FALHA (d): janela flutuante não apareceu (janelas: ${urls.join(", ")})`,
    );
  }
  watchErrors(floating, "floating");
  // Visibilidade pela própria página (document.visibilityState reflete o
  // BrowserWindow.show()); fallback ao main só se o canal estiver vivo.
  let floatingVisible = false;
  for (let i = 0; i < 20 && !floatingVisible; i++) {
    floatingVisible = await floating
      .evaluate(() => document.visibilityState === "visible")
      .catch(() => false);
    if (!floatingVisible) await sleep(250);
  }
  if (!floatingVisible) {
    floatingVisible = await app
      .evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some(
          (w) => w.webContents.getURL().endsWith("floating.html") && w.isVisible(),
        ),
      )
      .catch(() => false);
  }
  await floating
    .getByText(/^Gravando/)
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  const shot04a = await screenshot(floating, "meetings-04a-floating");
  await floating
    .getByPlaceholder("Nota rápida (Enter envia)")
    .fill(FLOATING_NOTE);
  await floating.getByRole("button", { name: "Adicionar" }).click();
  let floatingNoteSaved = false;
  for (let i = 0; i < 10 && !floatingNoteSaved; i++) {
    await sleep(300);
    floatingNoteSaved = (await apiGet(meetingId)).meeting.rawNotes.includes(
      FLOATING_NOTE,
    );
  }
  const shot04b = await screenshot(floating, "meetings-04b-floating-note");
  record(
    "(d) janela flutuante visível + nota rápida",
    floatingVisible && floatingNoteSaved ? "PASS" : "FAIL",
    `${shot04a}, ${shot04b} · visível=${floatingVisible} notaSalva=${floatingNoteSaved}`,
  );

  // --- (e) Notas na janela principal + "Salvo" -------------------------------
  const notes = page.getByPlaceholder("Suas anotações durante a reunião…");
  await notes.waitFor({ state: "visible", timeout: 5_000 });
  // Append (não fill): um fill substituiria a nota rápida da flutuante já
  // adotada pelo editor.
  await notes.click();
  await notes.press("End");
  await notes.press("Control+End");
  await notes.type(`\n${MAIN_NOTE}`);
  const savedVisible = await page
    .getByText("Salvo", { exact: true })
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  const afterNotes = (await apiGet(meetingId)).meeting.rawNotes;
  const shot05 = await screenshot(page, "meetings-05-notes-saved");
  record(
    '(e) Notas na principal → "Salvo"',
    savedVisible && afterNotes.includes(MAIN_NOTE) ? "PASS" : "FAIL",
    `${shot05} · salvoVisível=${savedVisible} notaNoBanco=${afterNotes.includes(MAIN_NOTE)}`,
  );
  // As duas notas coexistem: a da flutuante vira linha "- [mm:ss] …" pelo
  // main, e o autosave do editor principal anexa em vez de sobrescrever.
  const bothNotes =
    afterNotes.includes(`- [`) &&
    afterNotes.includes(FLOATING_NOTE) &&
    afterNotes.includes(MAIN_NOTE);
  record(
    "(e2) ambas as notas preservadas após autosave",
    bothNotes ? "PASS" : "FAIL",
    `rawNotes=${JSON.stringify(afterNotes)}`,
  );

  // --- (f) Parar → Processando → Concluída ----------------------------------
  await page.getByRole("button", { name: "Parar" }).first().click();
  let sawProcessing = false;
  let finalStatus = "";
  const deadlineF = Date.now() + FINISH_TIMEOUT_MS;
  while (Date.now() < deadlineF) {
    const d = await apiGet(meetingId);
    finalStatus = d.meeting.status;
    if (finalStatus === "processing") sawProcessing = true;
    if (finalStatus === "done" || finalStatus === "error") {
      finalDetail = d;
      break;
    }
    await sleep(500);
  }
  const statusLabelVisible = await page
    .getByText(
      finalStatus === "done"
        ? "Concluída"
        : finalStatus === "error"
          ? "Erro"
          : "Processando",
      { exact: true },
    )
    .first()
    .isVisible()
    .catch(() => false);
  const shot06 = await screenshot(page, "meetings-06-summary");
  if (finalStatus === "processing") {
    await screenshot(page, "meetings-06-debug-still-processing");
    record(
      "(f) Parar → Processando → Concluída",
      "PENDENTE",
      `PENDENTE W2-A: status ainda "processing" após ${FINISH_TIMEOUT_MS / 1000} s (pós-processamento não registrado?) · ${shot06}`,
    );
    throw new PendingW2A("pós-processamento pendente");
  }
  if (finalStatus === "error") {
    record(
      "(f) Parar → Processando → Concluída",
      "FAIL",
      `status=error: ${finalDetail?.meeting.error} · ${shot06}`,
    );
    throw new Error(
      `FALHA (f): reunião terminou em erro: ${finalDetail?.meeting.error}`,
    );
  }
  const tasksHeading = page.getByRole("heading", { name: "Tarefas" }).first();
  await tasksHeading.scrollIntoViewIfNeeded().catch(() => {});
  const shot07 = await screenshot(page, "meetings-07-tasks");
  const summaryInDom = await page
    .getByText("Próximas etapas", { exact: false })
    .first()
    .isVisible()
    .catch(() => false);
  const participantesInDom = await page
    .getByText("Participantes", { exact: false })
    .first()
    .isVisible()
    .catch(() => false);
  const proposedCheckboxes = await page
    .locator('input[type="checkbox"][aria-label^="Selecionar "]')
    .count();
  const createdLinkPre = await page
    .getByRole("button", { name: "Ver na área Tarefas" })
    .count();
  record(
    "(f) Parar → Processando → Concluída",
    statusLabelVisible && summaryInDom && participantesInDom ? "PASS" : "FAIL",
    `${shot06}, ${shot07} · viuProcessando=${sawProcessing} label=${statusLabelVisible} resumoNoDOM=${summaryInDom} participantesNoDOM=${participantesInDom} checkboxesPropostos=${proposedCheckboxes}`,
  );
  record(
    "(f2) nenhuma tarefa auto-criada antes do lote",
    createdLinkPre === 0 ? "PASS" : "FAIL",
    `linkVerTarefa (antes do lote)=${createdLinkPre}`,
  );

  // --- (f3) renomear speaker "Participante N" → "Ana" via UI ---------------
  const speakerBtn = page.getByRole("button", { name: /^Participante \d+$/ }).first();
  const speakerBtnVisible = await speakerBtn
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  let renameOk = false;
  let beforeLabel = "";
  if (speakerBtnVisible) {
    beforeLabel = ((await speakerBtn.textContent()) ?? "").trim();
    await speakerBtn.click();
    const input = page.getByRole("textbox", { name: `Renomear ${beforeLabel}` });
    await input.fill("Ana");
    await input.press("Enter");
    for (let i = 0; i < 10 && !renameOk; i++) {
      await sleep(300);
      renameOk = await page
        .getByRole("button", { name: "Ana" })
        .first()
        .isVisible()
        .catch(() => false);
    }
  }
  const shotRename = await screenshot(page, "meetings-07b-rename");
  record(
    "(f3) renomear participante → Ana",
    speakerBtnVisible && renameOk ? "PASS" : "FAIL",
    `${shotRename} · botãoVisível=${speakerBtnVisible} labelAntes=${beforeLabel} renomeadoNoDOM=${renameOk}`,
  );

  // --- (f4) criar tarefa em lote pela UI (item com dono "Mariana") ---------
  const marianaCheckbox = page.getByLabel(
    "Selecionar Comprar um servidor novo para o ambiente de staging",
  );
  const marianaVisible = await marianaCheckbox
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  let taskCreatedViaUi = false;
  if (marianaVisible) {
    await marianaCheckbox.check();
    await page.getByRole("button", { name: "Criar tarefas" }).click();
    for (let i = 0; i < 10 && !taskCreatedViaUi; i++) {
      await sleep(300);
      taskCreatedViaUi = await page
        .getByRole("button", { name: "Ver na área Tarefas" })
        .count()
        .then((c) => c === 1);
    }
  }
  const shotBatch = await screenshot(page, "meetings-07c-batch-created");
  record(
    "(f4) criar tarefas em lote pela UI",
    marianaVisible && taskCreatedViaUi ? "PASS" : "FAIL",
    `${shotBatch} · checkboxVisível=${marianaVisible} taskCriadaNoDOM=${taskCreatedViaUi}`,
  );
} catch (err) {
  if (!(err instanceof PendingW2A)) {
    console.log("[erro]", err instanceof Error ? err.message : String(err));
    await screenshot(page, "meetings-99-debug-failure").catch(() => {});
    if (!report.some((r) => r.verdict === "FAIL"))
      record(
        "execução",
        "FAIL",
        err instanceof Error ? err.message : String(err),
      );
  }
} finally {
  // Gravação ainda em andamento (falha antes do stop) — parar pra não deixar
  // capture timers vivos no app.close().
  try {
    const s = await apiState();
    if (s.active) {
      await page.evaluate(() =>
        (
          window as unknown as {
            api: { meetings: { stop: () => Promise<unknown> } };
          }
        ).api.meetings.stop(),
      );
    }
  } catch {
    // app já morto
  }
  stopLogs();
  await app.close();
  server.close();
}

// --- (g) banco (após o close: queryDb não lê o WAL) -------------------------
if (meetingId && finalDetail?.meeting.status === "done") {
  const meetings = await queryDb<{ status: string; summary_md: string | null }>(
    userDataCopy,
    `SELECT status, summary_md FROM meetings_v2 WHERE id = '${meetingId}'`,
  );
  const speakers = await queryDb<{ speaker: string; c: number }>(
    userDataCopy,
    `SELECT speaker, COUNT(*) AS c FROM meeting_v2_segments WHERE meeting_id = '${meetingId}' GROUP BY speaker`,
  );
  const items = await queryDb<{
    status: string;
    quote: string | null;
    grounded: number;
    task_id: string | null;
  }>(
    userDataCopy,
    `SELECT status, quote, grounded, task_id FROM meeting_v2_action_items WHERE meeting_id = '${meetingId}' ORDER BY created_at, rowid`,
  );
  const me = speakers.find((s) => s.speaker === "me")?.c ?? 0;
  const them = speakers.find((s) => s.speaker === "them")?.c ?? 0;
  // Comportamento novo: NADA é auto-criado — os 2 itens ficam "proposed",
  // um com owner "Eu" (ex-quote-real) e um com owner "Mariana" (criado via UI em f4).
  const groundedItem = items.find((i) => i.quote === GROUNDED_QUOTE);
  const marianaItem = items.find((i) =>
    (i.quote ?? "").includes("servidor novo para o staging"),
  );
  record(
    "(g) meetings_v2 done + summary_md",
    meetings[0]?.status === "done" && !!meetings[0]?.summary_md
      ? "PASS"
      : "FAIL",
    `status=${meetings[0]?.status} summary_md=${meetings[0]?.summary_md ? `${meetings[0].summary_md.length} chars` : "NULL"}`,
  );
  record(
    "(g) segmentos me/them",
    me >= 1 && them >= 1 ? "PASS" : "FAIL",
    `me=${me} them=${them}`,
  );
  record(
    "(g) action items ancorado(Eu) + criado via UI(Mariana)",
    groundedItem?.grounded === 1 &&
      groundedItem?.status === "proposed" &&
      marianaItem?.status === "created"
      ? "PASS"
      : "FAIL",
    JSON.stringify(items),
  );
  let taskOk = false;
  let taskEvidence = "task da item Mariana não encontrada";
  if (marianaItem?.task_id) {
    const tasks = await queryDb<{ id: string; origin: string; tags: string; title: string }>(
      userDataCopy,
      `SELECT id, origin, tags, title FROM tasks WHERE id = '${marianaItem.task_id}'`,
    );
    const t = tasks[0];
    let tags: string[] = [];
    try {
      tags = t ? (JSON.parse(t.tags) as string[]) : [];
    } catch {
      tags = [];
    }
    taskOk = !!t && tags.includes("meeting") && t.title.startsWith("[Mariana]");
    taskEvidence = t
      ? `task ${t.id} origin=${t.origin} tags=${t.tags} title=${t.title}`
      : `task_id ${marianaItem.task_id} não existe em tasks`;
  }
  record(
    "(g2) task criada em lote tem título [Mariana] + tag meeting",
    taskOk ? "PASS" : "FAIL",
    taskEvidence,
  );
  const voices = await queryDb<{ id: string; name: string }>(
    userDataCopy,
    `SELECT id, name FROM meeting_v2_voices`,
  );
  const speakersV2 = await queryDb<{ label: string }>(
    userDataCopy,
    `SELECT label FROM meeting_v2_speakers WHERE meeting_id = '${meetingId}'`,
  );
  const anaSegments = await queryDb<{ c: number }>(
    userDataCopy,
    `SELECT COUNT(*) AS c FROM meeting_v2_segments WHERE meeting_id = '${meetingId}' AND speaker_label = 'Ana'`,
  );
  record(
    "(g3) 2 speakers no banco (fixture ABAB)",
    speakersV2.length === 2 ? "PASS" : "FAIL",
    speakersV2.map((s) => s.label).join(", ") || "nenhum",
  );
  record(
    "(g4) renomear cria 1 voz + reescreve speaker_label",
    voices.length === 1 && (anaSegments[0]?.c ?? 0) > 0 ? "PASS" : "FAIL",
    `voices=${voices.map((v) => v.name).join(",")} segmentosAna=${anaSegments[0]?.c ?? 0}`,
  );
} else {
  record(
    "(g) banco",
    finalDetail ? "SKIP" : "SKIP",
    "pulado — reunião não chegou a done",
  );
}

// --- (h) atalho global: fora do harness -------------------------------------
record("(h) globalShortcut", "SKIP", "não testável no harness (por design)");

// --- (i) tray ---------------------------------------------------------------
await sleep(300); // stream do log fecha async
const log = readFileSync(logFile, "utf8");
const trayWarn = log.split("\n").filter((l) => l.includes("[meetings] tray"));
record(
  "(i) tray criado",
  trayWarn.length ? "FAIL" : "INFO",
  trayWarn.length
    ? trayWarn.join(" | ")
    : "não verificável diretamente: tray.ts só loga em falha; nenhum '[meetings] tray indisponível' no log do main",
);

// --- erros de console ----------------------------------------------------------
const unexpected = errors.filter(
  (e) => !KNOWN_ERROR_PATTERNS.some((re) => re.test(e)),
);
record(
  "console limpo",
  unexpected.length === 0 ? "PASS" : "FAIL",
  `${errors.length} erro(s) capturado(s), ${unexpected.length} inesperado(s)`,
);

console.log("\n=== FAKE STT: chamadas ===");
console.log(sttCalls.length ? sttCalls.join("\n") : "nenhuma");
console.log("\n=== ERROS DE CONSOLE ===");
console.log(errors.length === 0 ? "nenhum" : errors.join("\n"));
console.log("\n=== RESUMO ===");
for (const r of report) console.log(`${r.verdict.padEnd(8)} ${r.step}`);
console.log("log completo:", logFile);
const failed = report.some((r) => r.verdict === "FAIL");
const pending = report.some((r) => r.verdict === "PENDENTE");
console.log(
  failed
    ? "VALIDATE-MEETINGS-V2 FAILED"
    : pending
      ? "VALIDATE-MEETINGS-V2 PENDING (W2-A)"
      : "VALIDATE-MEETINGS-V2 DONE",
);
process.exit(failed ? 1 : 0);
