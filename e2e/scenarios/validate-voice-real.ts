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

// Valida o modo voz contra os ENDPOINTS REAIS de ~/.config/voz/voz.env — sem
// fake STT e sem override de VOZ_STT_URL/VOZ_STT_KEY. O main resolve as
// credenciais de verdade (VOZ_STT_KEY_CMD via gcloud, VOZ_TTS_KEY_CMD via grep
// no .env do atelier). CM_VOICE_FIXTURE continua trocando o áudio gravado pela
// fixture hello.webm, então o POST que chega ao Whisper real é o áudio ditado
// na gravação da fixture — a asserção é fuzzy sobre termos que a fala contém.
//
// TTS: chama window.api.voice.tts("ok") direto no renderer (mesma API do
// preload que o modo voz usa) e prova bytes > 1KB + Audio com duration > 0.
// Custo mínimo: 2 caracteres de síntese.
//
// Mesmo perfil-base PODADO do validate-voice.ts: boot sem panes e
// autoPullEnabled=false (o perfil real restaura N panes e o auto-pull faz git
// pull em repos reais).

const require = createRequire(import.meta.url);

async function prunedBaseProfile(): Promise<string> {
  const real = resolveRealUserData();
  const dir = mkdtempSync(join(tmpdir(), "cm-voice-real-base-"));
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

// A fala da fixture cita estes termos — basta UM sobreviver no eco do PTY
// (a TUI quebra linhas longas; frase inteira não sobrevive intacta).
const FUZZY_TERMS = ["microfone", "composer", "pitfall", "pitwall"];

const { app, page } = await launchApp({
  extraArgs: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
  env: {
    // SEM VOZ_STT_URL/VOZ_STT_KEY: o main lê ~/.config/voz/voz.env real.
    CM_VOICE_FIXTURE: join(REPO_ROOT, "e2e/fixtures/voice/hello.webm"),
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

  const collapseCrew = page.getByTitle("Recolher a equipe").first();
  if (await collapseCrew.count()) {
    await collapseCrew.click().catch(() => {});
    await page.waitForTimeout(400);
    console.log("[crew-dock] recolhido");
  }

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
  if (!clickable) throw new Error("FALHA: nenhum botão de voz clicável");
  const pane = page.locator("body");

  // --- 1. mic idle ----------------------------------------------------------
  await screenshot(page, "voice-real-01-mic-idle");

  // --- 2. gravar e transcrever no STT REAL ----------------------------------
  const sessions = (await page.evaluate(() => {
    const w = window as unknown as {
      api: {
        sessions: { list: () => Promise<Array<{ id?: string }>> };
      };
    };
    return w.api.sessions.list();
  })) as Array<{ id?: string }>;
  const sessionId = sessions[0]?.id ?? null;
  console.log("[sessão] id:", sessionId);
  if (!sessionId) throw new Error("INCONCLUSIVE: sessão sem id");

  const getBacklog = () =>
    page.evaluate((id) => {
      const w = window as unknown as {
        api: { sessions: { getBacklog: (id: string) => Promise<string> } };
      };
      return w.api.sessions.getBacklog(id);
    }, sessionId) as Promise<string>;

  const countTerm = (text: string, term: string) =>
    text.toLowerCase().split(term).length - 1;

  // O backlog de boot já contém "pitwall" etc. (CLAUDE.md/memória ecoados na
  // TUI) — a prova é o DELTA: só conta match se o termo aparecer MAIS vezes
  // do que na linha de base tirada antes da gravação.
  const baseline = await getBacklog();
  const baseCounts = new Map(
    FUZZY_TERMS.map((t) => [t, countTerm(baseline, t)]),
  );
  console.log(
    "[stt] baseline de termos no backlog:",
    JSON.stringify(Object.fromEntries(baseCounts)),
  );

  await micIdle.click();
  const recording = pane.getByTitle("Parar a gravação e transcrever").first();
  await recording.waitFor({ state: "visible", timeout: 10_000 });
  console.log("[mic] gravando");
  await page.waitForTimeout(900); // > MIN_RECORDING_MS

  await recording.click();
  console.log("[stt] parado — aguardando transcrição real…");

  // Rede real: gcloud resolve o secret (~1s) + upload + whisper. Poll até 90s.
  // Se o MicButton cair em erro, o title carrega a mensagem PT exata — reportar.
  let matched: string | null = null;
  let voiceError: string | null = null;
  for (let i = 0; i < 180; i++) {
    const failBtn = pane.getByText("Voz falhou", { exact: false }).first();
    if (await failBtn.count()) {
      voiceError = await failBtn
        .locator("xpath=ancestor-or-self::button")
        .first()
        .getAttribute("title");
      break;
    }
    const backlog = await getBacklog();
    matched =
      FUZZY_TERMS.find(
        (t) => countTerm(backlog, t) > (baseCounts.get(t) ?? 0),
      ) ?? null;
    if (matched) {
      // Evidência: o trecho do eco em volta da ocorrência NOVA do termo.
      const low = backlog.toLowerCase();
      const idx = low.lastIndexOf(matched);
      console.log(
        "[stt] trecho do eco:",
        JSON.stringify(backlog.slice(Math.max(0, idx - 80), idx + 80)),
      );
      break;
    }
    await page.waitForTimeout(500);
  }
  if (voiceError) {
    await screenshot(page, "voice-real-99-stt-error");
    throw new Error(`FALHA STT real: ${voiceError}`);
  }
  console.log("[stt] termo NOVO da fala real ecoado no PTY:", matched);
  // Espera o MicButton voltar ao idle antes do screenshot — o estado final é
  // a prova visual (não o "Transcrevendo…" em trânsito).
  await pane
    .getByTitle("Ditar por voz", { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => {});
  await screenshot(page, "voice-real-02-text-in-prompt");
  if (!matched)
    throw new Error(
      "FALHA: transcrição real não chegou ao prompt em 90s (nenhum termo novo no backlog)",
    );

  // --- 3. TTS REAL via API do preload ---------------------------------------
  // A prova de "áudio de verdade" é decodeAudioData: duration > 0 exige um mp3
  // decodificável, não só bytes. O caminho Audio+blob (o que useVoiceSpeaker
  // usa em produção) é medido junto e reportado sem derrubar o cenário: a CSP
  // do renderer (default-src 'self', sem media-src) hoje rejeita blob: pra
  // mídia — bug conhecido, o erro exato sai no log.
  const tts = (await page.evaluate(async () => {
    const w = window as unknown as {
      api: {
        voice: {
          tts: (
            text: string,
          ) => Promise<
            | { ok: true; bytes: Uint8Array; mime: string }
            | { ok: false; error: string }
          >;
        };
      };
    };
    const res = await w.api.voice.tts("ok");
    if (!res.ok) return { ok: false as const, error: res.error };
    const buffer = res.bytes.slice().buffer as ArrayBuffer;

    const ctx = new AudioContext();
    let duration = 0;
    let decodeError: string | null = null;
    try {
      const decoded = await ctx.decodeAudioData(buffer.slice(0));
      duration = decoded.duration;
    } catch (err) {
      decodeError = err instanceof Error ? err.message : String(err);
    } finally {
      void ctx.close();
    }

    const blob = new Blob([buffer], { type: res.mime || "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    const element = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), 15_000);
      audio.addEventListener("loadedmetadata", () => {
        clearTimeout(timer);
        resolve(`ok duration=${audio.duration}`);
      });
      audio.addEventListener("error", () => {
        clearTimeout(timer);
        const e = audio.error;
        resolve(
          e ? `erro code=${e.code}: ${e.message}` : "erro sem MediaError",
        );
      });
    });
    URL.revokeObjectURL(url);

    return {
      ok: true as const,
      byteLength: res.bytes.byteLength,
      mime: res.mime,
      duration,
      decodeError,
      element,
    };
  })) as
    | {
        ok: true;
        byteLength: number;
        mime: string;
        duration: number;
        decodeError: string | null;
        element: string;
      }
    | { ok: false; error: string };

  if (!tts.ok) throw new Error(`FALHA TTS real: ${tts.error}`);
  console.log(
    `[tts] bytes: ${tts.byteLength}, mime: ${tts.mime}, duration: ${tts.duration}s`,
  );
  console.log(`[tts] Audio(blob) no renderer: ${tts.element}`);
  if (tts.byteLength <= 1024)
    throw new Error(`FALHA TTS: só ${tts.byteLength} bytes (esperado > 1KB)`);
  if (tts.decodeError)
    throw new Error(`FALHA TTS: mp3 não decodifica: ${tts.decodeError}`);
  if (!(tts.duration > 0))
    throw new Error(`FALHA TTS: duration ${tts.duration} (esperado > 0)`);

  // --- 4. toggle modo voz ---------------------------------------------------
  const toggle = pane.getByRole("button", { name: "Modo voz" }).first();
  await toggle.click();
  await page.waitForTimeout(600);
  console.log(
    "[modo voz] aria-pressed:",
    await toggle.getAttribute("aria-pressed"),
  );
  await screenshot(page, "voice-real-03-voice-mode-on");
  await toggle.click();
  await page.waitForTimeout(400);

  // --- 5. Settings → aba Voz ------------------------------------------------
  await page.getByTitle("Configurações").first().click();
  const settingsNav = page
    .locator("nav")
    .filter({ hasText: "Variáveis de ambiente" });
  await settingsNav.getByRole("button", { name: "Voz", exact: true }).click();
  await page.getByText("Endpoint configurado").waitFor({
    state: "visible",
    timeout: 10_000,
  });
  console.log("[settings] aba Voz com endpoint real configurado");
  await screenshot(page, "voice-real-04-settings-voz");

  console.log("\n=== ERROS DE CONSOLE ===");
  console.log(errors.length === 0 ? "nenhum" : errors.join("\n"));
  console.log("log completo:", logFile);
  console.log("VALIDATE-VOICE-REAL DONE");
} finally {
  stop();
  await app.close();
}
