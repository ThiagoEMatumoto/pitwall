import { createServer } from "node:http";
import {
  cpSync,
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
import { launchApp, REPO_ROOT, resolveRealUserData } from "../driver/launch";
import { goToArea, toggleProject, waitReady } from "../driver/nav";

// Valida o modo voz de ponta a ponta sem microfone humano nem rede externa:
// 1. fake STT server local responde verbose_json com texto fixo (VOZ_STT_URL
//    aponta pra ele via env — precedência ambiente > voz.env);
// 2. CM_VOICE_FIXTURE troca o áudio do MediaRecorder pela fixture wav no main;
// 3. flags de mídia fake do Chromium deixam o getUserMedia real passar.
// Screenshots: mic no composer, gravando, transcrevendo, texto no composer,
// toggle do modo voz e chip de resumo (broadcast simulado pelo main).
//
// O perfil real restaura N panes de sessão lado a lado — o botão de voz fica
// clipado/sobreposto e o auto-pull ainda faz git pull nos repos reais. Por isso
// o cenário lança sobre um perfil-base PODADO: só o app.db real, com o layout
// do workspace zerado (boot sem panes) e autoPullEnabled=false.

const require = createRequire(import.meta.url);

async function prunedBaseProfile(): Promise<string> {
  const real = resolveRealUserData();
  const dir = mkdtempSync(join(tmpdir(), "cm-voice-base-"));
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
  writeFileSync(join(dir, "app.db"), Buffer.from(db.export()));
  db.close();
  return dir;
}

process.env.CM_REAL_USERDATA = await prunedBaseProfile();
console.log("[perfil] base podada em", process.env.CM_REAL_USERDATA);

const TRANSCRIPT =
  "Olá Pitwall, este é um teste do modo voz ditado pela fixture.";

const sttRequests: string[] = [];
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    sttRequests.push(
      `${req.method} ${req.url} body=${Buffer.concat(chunks).length}B`,
    );
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        text: TRANSCRIPT,
        language: "pt",
        no_speech_prob: 0.01,
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

const { app, page } = await launchApp({
  extraArgs: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
  env: {
    VOZ_STT_URL: `http://127.0.0.1:${port}/v1/audio/transcriptions`,
    VOZ_STT_KEY: "chave-de-teste-e2e",
    CM_VOICE_FIXTURE: join(REPO_ROOT, "e2e/fixtures/voice/hello.wav"),
  },
});
const { logFile, stop } = captureLogs(app, page);

const errors: string[] = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
});

try {
  await waitReady(page);
  await goToArea(page, "projects");
  await page.waitForTimeout(500);

  // Abre uma sessão nova no primeiro projeto que exibir o trigger.
  for (const proj of [
    "Pessoal",
    "claude-manager",
    "Diligencia",
    "LASS",
    "Assistente",
  ]) {
    try {
      await toggleProject(page, proj);
      await page.waitForTimeout(400);
    } catch {
      // projeto ausente neste perfil — tenta o próximo
    }
    if (await page.locator('[title^="Nova sessão"]').count()) break;
  }
  const trigger = page.locator('[title^="Nova sessão"]').first();
  if (!(await trigger.count()))
    throw new Error('INCONCLUSIVE: sem trigger "Nova sessão"');
  await trigger.click();
  // O trigger abre o SpawnSessionDialog — confirmar com "Abrir" dispara o spawn.
  const openBtn = page
    .getByRole("button", { name: "Abrir", exact: true })
    .first();
  const hasDialog = await openBtn
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (hasDialog) await openBtn.click();
  console.log(
    "[sessão] spawn (dialog confirmado:",
    hasDialog,
    ") — aguardando boot…",
  );
  await page.waitForTimeout(10_000);

  // O Crew Dock expandido (dados reais no perfil copiado) cobre a borda direita
  // do pane e intercepta o clique no composer — recolher antes de interagir.
  const collapseCrew = page.getByTitle("Recolher a equipe").first();
  if (await collapseCrew.count()) {
    await collapseCrew.click().catch(() => {});
    await page.waitForTimeout(400);
    console.log("[crew-dock] recolhido");
  }

  // Perfis reais têm outros panes de sessão atrás do ativo (dockview mantém
  // todos no DOM, alguns fora do viewport). Varrer os candidatos com um clique
  // de ensaio (trial checa oclusão/viewport sem clicar) acha o mic do pane
  // realmente visível; o escopo das próximas interações é o overlay dele.
  await page
    .getByTitle("Ditar por voz", { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  const mics = page.getByTitle("Ditar por voz", { exact: false });
  const total = await mics.count();
  let micIdle = mics.first();
  let clickable = false;
  for (let i = 0; i < total; i++) {
    const cand = mics.nth(i);
    try {
      await cand.click({ timeout: 2_000, trial: true });
      micIdle = cand;
      clickable = true;
      break;
    } catch {
      // soterrado ou fora do viewport — próximo candidato
    }
  }
  console.log(`[mic] candidatos: ${total}, clicável: ${clickable}`);
  if (!clickable) {
    await screenshot(page, "voice-00-debug-no-clickable-mic");
    for (let i = 0; i < total; i++) {
      const box = await mics
        .nth(i)
        .boundingBox()
        .catch(() => null);
      let blocker = "sem box";
      if (box) {
        blocker = await page.evaluate(
          ([x, y]) => {
            const el = document.elementFromPoint(x, y);
            return el
              ? `${el.tagName}.${String(el.className).slice(0, 80)}`
              : "nada";
          },
          [box.x + box.width / 2, box.y + box.height / 2],
        );
      }
      console.log(`[mic] cand ${i}: box=${JSON.stringify(box)} top=${blocker}`);
    }
    throw new Error("FALHA: nenhum botão de voz clicável");
  }
  // Com a base podada há um único pane de sessão — o body basta como escopo
  // (um escopo derivado do botão idle quebraria: o title muda a cada estado).
  const pane = page.locator("body");

  // --- 1. mic no composer ---------------------------------------------------
  console.log('[mic] botão "Voz" visível');
  await screenshot(page, "voice-01-mic-idle");

  // --- 2. gravando (MediaRecorder real sobre o device fake) -----------------
  await micIdle.click();
  const recording = pane.getByTitle("Parar a gravação e transcrever").first();
  try {
    await recording.waitFor({ state: "visible", timeout: 10_000 });
  } catch (err) {
    await screenshot(page, "voice-98-debug-no-recording");
    const titles = await pane
      .locator("button[title]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("title")));
    console.log("[debug] botões no pane:", JSON.stringify(titles));
    throw err;
  }
  console.log("[mic] gravando");
  await screenshot(page, "voice-02-recording");
  await page.waitForTimeout(900); // > MIN_RECORDING_MS (400ms) pra não descartar

  // --- 3. transcrevendo -----------------------------------------------------
  await recording.click();
  const transcribing = pane
    .getByText("Transcrevendo…", { exact: false })
    .first();
  const sawTranscribing = await transcribing
    .waitFor({ state: "visible", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (sawTranscribing) await screenshot(page, "voice-03-transcribing");
  console.log("[mic] estado transcrevendo visível:", sawTranscribing);

  // --- 4. texto no composer (draft) -----------------------------------------
  // onVoiceText → composerRef.appendText: o ditado entra no DRAFT do composer,
  // um textarea real no DOM — prova mais forte que o eco em canvas do PTY, e
  // visível/editável nos dois modos. O envio segue pelo submit normal.
  const sessions = (await page.evaluate(() => {
    const w = window as unknown as {
      api: {
        sessions: {
          list: () => Promise<Array<{ id?: string; ccSessionId?: string }>>;
        };
      };
    };
    return w.api.sessions.list();
  })) as Array<{ id?: string; ccSessionId?: string }>;
  const newest = sessions[0] ?? {};
  const ccSessionId = newest.ccSessionId ?? newest.id ?? null;
  console.log("[sessão] ccSessionId:", ccSessionId);

  const composerBox = pane
    .locator('textarea[aria-label^="Escreva um prompt"]')
    .first();
  let inComposer = false;
  for (let i = 0; i < 30; i++) {
    const value = await composerBox.inputValue().catch(() => "");
    if (value.includes("fixture")) {
      inComposer = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  console.log("[composer] ditado no draft:", inComposer);
  console.log("[fake-stt] requisições:", JSON.stringify(sttRequests));
  await screenshot(page, "voice-04-text-in-composer");
  if (!inComposer)
    throw new Error("FALHA: a transcrição não chegou ao composer");

  // --- 4b. draft visível também no OUTRO modo (Terminal⇄Chat) ---------------
  // O draft vive no Composer (montado nos dois modos); alternar o modo do pane
  // não pode sumir com o texto ditado.
  const modeToggle = pane
    .locator(
      '[aria-label="Mudar para Chat"], [aria-label="Mudar para Terminal"]',
    )
    .first();
  if (!(await modeToggle.count()))
    throw new Error("FALHA: toggle Terminal⇄Chat não encontrado");
  const fromLabel = await modeToggle.getAttribute("aria-label");
  await modeToggle.click();
  await page.waitForTimeout(800);
  const afterToggle = await composerBox.inputValue().catch(() => "");
  const stillThere = afterToggle.includes("fixture");
  console.log(
    `[modo] alternado via "${fromLabel}" — draft segue no composer:`,
    stillThere,
  );
  await screenshot(page, "voice-04b-text-after-mode-toggle");
  if (!stillThere)
    throw new Error("FALHA: o draft sumiu ao alternar o modo do pane");
  // Volta pro modo original antes das próximas etapas.
  await modeToggle.click();
  await page.waitForTimeout(600);

  // --- 5. toggle modo voz ---------------------------------------------------
  const toggle = pane.getByRole("button", { name: "Modo voz" }).first();
  await toggle.click();
  await page.waitForTimeout(600);
  console.log(
    "[modo voz] aria-pressed:",
    await toggle.getAttribute("aria-pressed"),
  );
  await screenshot(page, "voice-05-voice-mode-on");
  // Desliga antes do chip: com o modo ligado o chip tentaria TTS real (sem
  // credencial aqui) e sujaria o log com o erro esperado.
  await toggle.click();
  await page.waitForTimeout(400);

  // --- 6. chip de resumo (broadcast simulado pelo main) ---------------------
  if (ccSessionId) {
    await app.evaluate(
      ({ BrowserWindow }, payload) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("voice:summary", payload);
        }
      },
      {
        ccSessionId,
        summary:
          "Resumo simulado: o turno terminou e este chip é o modo voz renderizando.",
      },
    );
    const chip = pane.getByTitle("Resumo do último turno (modo voz)").first();
    const chipVisible = await chip
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    console.log("[chip] visível:", chipVisible);
    await screenshot(page, "voice-06-summary-chip");
  } else {
    console.log("[chip] sem ccSessionId — simulação pulada");
  }

  console.log("\n=== ERROS DE CONSOLE ===");
  console.log(errors.length === 0 ? "nenhum" : errors.join("\n"));
  console.log("log completo:", logFile);
  console.log("VALIDATE-VOICE DONE");
} finally {
  stop();
  await app.close();
  server.close();
}
