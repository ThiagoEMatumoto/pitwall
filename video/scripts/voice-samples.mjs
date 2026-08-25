#!/usr/bin/env node
// Amostras comparaveis de voz para escolher a expressividade da narracao.
//
// Gera, por locale, a MESMA frase (cold-open + outro concatenados) em varias
// configuracoes de voice_settings/modelo/voz, para comparacao lado a lado.
// Nao toca em tts.mjs, script.json nem no manifesto de audio.
//
// Uso:
//   node scripts/voice-samples.mjs --list-models     modelos visiveis para a conta
//   node scripts/voice-samples.mjs --list-voices     vozes da conta (id, nome, labels)
//   node scripts/voice-samples.mjs --plan            o que seria gerado, sem gastar
//   node scripts/voice-samples.mjs --go              gera as amostras
//   node scripts/voice-samples.mjs --go --only=pt-04 gera so uma variacao

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const VIDEO_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT_PATH = join(VIDEO_DIR, "content", "script.json");
const OUT_DIR = join(VIDEO_DIR, "out", "voice-samples");

const TTS_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------- credencial
// Copia fiel do bloco de credencial de scripts/tts.mjs (que nao exporta nada —
// importar aquele arquivo executaria o main dele). Mesma precedencia, mesmo
// suporte a VOZ_TTS_KEY_CMD, mesma segunda tentativa via ADC.

function parseDotenv(text) {
  const out = {};
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    if (line.startsWith("export "))
      line = line.slice("export ".length).trimStart();
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    if (!key || !/^[A-Za-z_]/.test(key)) continue;
    const value = line.slice(eq + 1).trim();
    const quote = value.slice(0, 1);
    if (quote === "'" || quote === '"') {
      const close = value.indexOf(quote, 1);
      out[key] = close > 0 ? value.slice(1, close) : value.slice(1);
    } else {
      out[key] = value.split("#")[0].trim();
    }
  }
  return out;
}

const ALIASES = {
  VOZ_TTS_KEY: ["ELEVENLABS_API_KEY"],
  VOZ_TTS_KEY_CMD: ["ELEVENLABS_API_KEY_CMD"],
};

function vozEnvPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "voz", "voz.env");
}

function readVozVars() {
  const path = vozEnvPath();
  if (!existsSync(path)) return {};
  try {
    return parseDotenv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function lookup(name, vars) {
  if (process.env[name] !== undefined) return process.env[name];
  if (vars[name] !== undefined) return vars[name];
  for (const old of ALIASES[name] ?? []) {
    if (process.env[old] !== undefined) return process.env[old];
    if (vars[old] !== undefined) return vars[old];
  }
  return "";
}

function envWithGcloudPath() {
  const dirs = [
    join(homedir(), "google-cloud-sdk", "bin"),
    join(homedir(), ".local", "google-cloud-sdk", "bin"),
    "/usr/lib/google-cloud-sdk/bin",
    "/snap/bin",
  ];
  const extras = dirs.filter((dir) => existsSync(join(dir, "gcloud")));
  if (extras.length === 0) return { ...process.env };
  return {
    ...process.env,
    PATH: [...extras, process.env.PATH ?? ""].join(":"),
  };
}

const runShell = (cmd, env) =>
  execFileAsync("bash", ["-c", cmd], {
    timeout: 45_000,
    env,
    maxBuffer: 4 * 1024 * 1024,
  });

async function adcToken() {
  try {
    const { stdout } = await runShell(
      "gcloud auth application-default print-access-token",
      envWithGcloudPath(),
    );
    return stdout.trim();
  } catch {
    return "";
  }
}

async function resolveElevenLabsKey() {
  const vars = readVozVars();
  const direct = lookup("VOZ_TTS_KEY", vars);
  if (direct) return { ok: true, value: direct, source: "valor direto" };

  const cmd = lookup("VOZ_TTS_KEY_CMD", vars);
  if (!cmd) {
    return {
      ok: false,
      error: `Credencial nao configurada — defina ELEVENLABS_API_KEY no ambiente ou VOZ_TTS_KEY / VOZ_TTS_KEY_CMD em ${vozEnvPath()}.`,
    };
  }

  let motivo = "";
  try {
    const { stdout, stderr } = await runShell(cmd, envWithGcloudPath());
    const value = stdout.trim();
    if (value) return { ok: true, value, source: "VOZ_TTS_KEY_CMD" };
    motivo = stderr.trim() || "o comando da credencial saiu vazio";
  } catch (err) {
    motivo = err.stderr?.trim() || err.message || String(err);
  }

  if (cmd.includes("gcloud")) {
    const token = await adcToken();
    if (token) {
      try {
        const { stdout } = await runShell(cmd, {
          ...envWithGcloudPath(),
          CLOUDSDK_AUTH_ACCESS_TOKEN: token,
        });
        const value = stdout.trim();
        if (value)
          return { ok: true, value, source: "VOZ_TTS_KEY_CMD (via ADC)" };
      } catch {
        // cai na mensagem abaixo
      }
    }
    return {
      ok: false,
      error: `Falha ao obter a credencial: ${motivo} — a sessao do gcloud provavelmente venceu; rode \`gcloud auth login\` e tente de novo.`,
    };
  }
  return { ok: false, error: `Falha ao obter a credencial: ${motivo}` };
}

// ------------------------------------------------------------------- variacoes
// stability baixa = mais variacao de entonacao E de ritmo; por isso cada amostra
// e medida (duracao + loudness) e comparada com a baseline.
const SETTINGS = {
  expressivo: {
    stability: 0.4,
    similarity_boost: 0.75,
    style: 0.55,
    use_speaker_boost: true,
  },
  energetico: {
    stability: 0.3,
    similarity_boost: 0.7,
    style: 0.75,
    use_speaker_boost: true,
  },
};

// Tags de emocao so existem no eleven_v3; nos outros modelos virariam texto lido.
const V3_TAGS = {
  "pt-BR": ["[excited]", "[confident]"],
  en: ["[excited]", "[confident]"],
};

function buildVariants(script, altVoices) {
  const baseModel = script.tts.modelId;
  const byId = new Map(script.scenes.map((s) => [s.id, s]));
  const out = [];

  for (const locale of script.locales) {
    const prefix = locale === "pt-BR" ? "pt" : "en";
    const voice = script.tts.voices[locale];
    const cold = byId.get("cold-open").narration[locale];
    const outro = byId.get("outro").narration[locale];
    const text = `${cold}\n\n${outro}`;

    const push = (n, label, extra) =>
      out.push({
        locale,
        key: `${prefix}-${String(n).padStart(2, "0")}`,
        file: join(
          OUT_DIR,
          `${prefix}-${String(n).padStart(2, "0")}-${label}.mp3`,
        ),
        voiceId: voice.voiceId,
        voiceName: voice.name,
        modelId: baseModel,
        text,
        // As cenas tambem separadas: so assim a duracao e comparavel 1:1 com o
        // audio-manifest.json, que e por cena (o arquivo concatenado carrega uma
        // pausa entre os blocos que nao existe no filme).
        parts: [
          { id: "cold-open", text: cold },
          { id: "outro", text: outro },
        ],
        label,
        ...extra,
      });

    push(1, "baseline", { settings: null });
    push(2, "expressivo", { settings: SETTINGS.expressivo });
    push(3, "energetico", { settings: SETTINGS.energetico });

    // v3: tags discretas no inicio de cada frase-bloco.
    const [tagA, tagB] = V3_TAGS[locale];
    push(4, "v3-tags", {
      settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        use_speaker_boost: true,
      },
      modelId: "eleven_v3",
      text: `${tagA} ${cold}\n\n${tagB} ${outro}`,
      parts: [
        { id: "cold-open", text: `${tagA} ${cold}` },
        { id: "outro", text: `${tagB} ${outro}` },
      ],
    });

    // Vozes alternativas do catalogo da conta, todas na config "expressivo"
    // para que a unica variavel entre elas seja o timbre.
    let n = 5;
    for (const alt of altVoices?.[locale] ?? []) {
      push(n++, `alternativa-${alt.slug}`, {
        settings: SETTINGS.expressivo,
        voiceId: alt.voiceId,
        voiceName: alt.name,
      });
    }
  }
  return out;
}

// --------------------------------------------------------------------- api
async function apiGet(path, key) {
  const res = await fetch(`https://api.elevenlabs.io${path}`, {
    headers: { "xi-api-key": key },
  });
  const body = await res.text();
  if (res.status !== 200)
    throw new Error(`HTTP ${res.status} em ${path}: ${body.slice(0, 400)}`);
  return JSON.parse(body);
}

async function synthesize({ text, voiceId, modelId, settings }, key) {
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream` +
    "?output_format=mp3_44100_128";
  const body = { text, model_id: modelId };
  if (settings) body.voice_settings = settings;

  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
  });

  if (res.status !== 200) {
    const detalhe = (await res.text().catch(() => "")).slice(0, 500);
    const err = new Error(
      `HTTP ${res.status}${detalhe ? " — " + detalhe : ""}`,
    );
    err.httpStatus = res.status;
    throw err;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error("a API devolveu um arquivo vazio");
  return bytes;
}

// ------------------------------------------------------------------- medidas
async function measure(absPath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    absPath,
  ]);
  const durationSec = Number(stdout.trim());

  // ebur128 escreve o Summary no stderr; -f null descarta o audio.
  let stderr = "";
  try {
    const r = await execFileAsync(
      "ffmpeg",
      ["-nostdin", "-i", absPath, "-af", "ebur128", "-f", "null", "-"],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    stderr = r.stderr;
  } catch (err) {
    stderr = err.stderr ?? "";
  }
  const tail = stderr.slice(stderr.lastIndexOf("Summary"));
  const num = (re) => {
    const m = tail.match(re);
    return m ? Number(m[1]) : null;
  };
  return {
    durationSec,
    integratedLufs: num(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/),
    lra: num(/LRA:\s*(-?\d+(?:\.\d+)?)\s*LU/),
    truePeakDb: num(/Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/),
  };
}

// ---------------------------------------------------------------------- main
function parseArgs(argv) {
  const flag = (n) =>
    argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  const value = (n, fb) => {
    const f = flag(n);
    if (!f) return fb;
    const eq = f.indexOf("=");
    return eq === -1 ? fb : f.slice(eq + 1);
  };
  return {
    listModels: Boolean(flag("list-models")),
    listVoices: Boolean(flag("list-voices")),
    go: Boolean(flag("go")),
    perScene: Boolean(flag("per-scene")),
    // Prova de que as audio tags do eleven_v3 foram consumidas como direcao e
    // nao lidas em voz alta — sem isso, "[excited]" no texto e um risco cego.
    transcribe: value("transcribe", ""),
    only: value("only", ""),
    altFile: value("alt", join(OUT_DIR, "alt-voices.json")),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const script = JSON.parse(readFileSync(SCRIPT_PATH, "utf8"));

  if (args.listModels || args.listVoices) {
    const key = await resolveElevenLabsKey();
    if (!key.ok) throw new Error(key.error);
    if (args.listModels) {
      const models = await apiGet("/v1/models", key.value);
      for (const m of models) {
        console.log(
          `${m.model_id.padEnd(34)} tts=${m.can_do_text_to_speech}  langs=${(m.languages ?? []).length}  ${m.name}`,
        );
      }
    }
    if (args.listVoices) {
      const { voices } = await apiGet("/v2/voices?page_size=100", key.value);
      for (const v of voices) {
        const l = v.labels ?? {};
        console.log(
          [
            v.voice_id,
            (v.name ?? "").padEnd(26),
            (l.language ?? l.accent ?? "?").padEnd(12),
            (l.gender ?? "?").padEnd(8),
            (l.age ?? "?").padEnd(12),
            (l.descriptive ?? l.description ?? "?").padEnd(14),
            l.use_case ?? "?",
          ].join("  "),
        );
      }
    }
    return;
  }

  if (args.transcribe) {
    const key = await resolveElevenLabsKey();
    if (!key.ok) throw new Error(key.error);
    for (const path of args.transcribe.split(",")) {
      const form = new FormData();
      form.append("model_id", "scribe_v1");
      form.append(
        "file",
        new Blob([readFileSync(path)]),
        path.split("/").pop(),
      );
      const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": key.value },
        body: form,
      });
      const body = await res.text();
      console.log(
        `${path.split("/").pop()}\n  ${res.status === 200 ? JSON.parse(body).text : `HTTP ${res.status} — ${body.slice(0, 300)}`}\n`,
      );
    }
    return;
  }

  const altVoices = existsSync(args.altFile)
    ? JSON.parse(readFileSync(args.altFile, "utf8"))
    : null;
  let variants = buildVariants(script, altVoices);
  if (args.only) variants = variants.filter((v) => v.file.includes(args.only));

  if (args.perScene) {
    variants = variants.flatMap((v) =>
      v.parts.map((p) => ({
        ...v,
        text: p.text,
        sceneId: p.id,
        label: `${v.label}/${p.id}`,
        file: join(
          OUT_DIR,
          "per-scene",
          `${v.file
            .split("/")
            .pop()
            .replace(/\.mp3$/, "")}__${p.id}.mp3`,
        ),
      })),
    );
  }

  if (!args.go) {
    console.log("PLANO (nada e enviado a API)\n");
    let chars = 0;
    for (const v of variants) {
      chars += v.text.length;
      console.log(
        `  ${v.key}  ${v.label.padEnd(26)} ${v.modelId.padEnd(22)} voz ${v.voiceName.padEnd(28)} ${v.text.length} chars  ${v.settings ? JSON.stringify(v.settings) : "(sem voice_settings)"}`,
      );
    }
    console.log(`\n  total: ${variants.length} amostras, ${chars} caracteres`);
    return;
  }

  const key = await resolveElevenLabsKey();
  if (!key.ok) throw new Error(key.error);
  console.log(`credencial obtida (${key.source})\n`);

  mkdirSync(join(OUT_DIR, "per-scene"), { recursive: true });
  const results = [];
  for (const v of variants) {
    try {
      const bytes = await synthesize(v, key.value);
      writeFileSync(v.file, bytes);
      const m = await measure(v.file);
      results.push({
        ...v,
        ok: true,
        ...m,
        kb: Math.round(bytes.length / 1024),
      });
      console.log(
        `  ok    ${v.file.split("/").pop().padEnd(34)} ${m.durationSec.toFixed(2)}s  ${m.integratedLufs} LUFS  LRA ${m.lra}  peak ${m.truePeakDb} dBFS`,
      );
    } catch (err) {
      results.push({ ...v, ok: false, error: err.message });
      console.log(
        `  FALHA ${v.file.split("/").pop().padEnd(34)} ${err.message}`,
      );
    }
  }

  const report = results.map((r) => ({
    file: r.file,
    locale: r.locale,
    label: r.label,
    modelId: r.modelId,
    voiceId: r.voiceId,
    voiceName: r.voiceName,
    settings: r.settings,
    chars: r.text.length,
    ok: r.ok,
    error: r.error ?? null,
    durationSec: r.durationSec ?? null,
    integratedLufs: r.integratedLufs ?? null,
    lra: r.lra ?? null,
    truePeakDb: r.truePeakDb ?? null,
  }));
  writeFileSync(
    join(
      OUT_DIR,
      args.perScene ? "measurements-per-scene.json" : "measurements.json",
    ),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    `\nmedidas: ${join(OUT_DIR, args.perScene ? "measurements-per-scene.json" : "measurements.json")}`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
