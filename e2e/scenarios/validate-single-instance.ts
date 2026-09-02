import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { screenshot } from "../driver/capture";
import { launchApp } from "../driver/launch";
import { waitReady } from "../driver/nav";

// requestSingleInstanceLock (electron/main/index.ts:97-107): a 2ª instância,
// lançada com o MESMO --user-data-dir, deve sair (app.exit(0)) e devolver o
// foco à 1ª via 'second-instance'. Aqui replicamos o binário/args reais do
// harness (launch.ts) num child_process cru, porque playwright's
// electron.launch() não permite dois `_electron.launch()` concorrentes
// apontando pro mesmo processo do SO sob o mesmo lock.

type Verdict = "PASS" | "FAIL" | "SKIP" | "INFO";
const report: Array<{ step: string; verdict: Verdict; evidence: string }> = [];
function record(step: string, verdict: Verdict, evidence: string): void {
  report.push({ step, verdict, evidence });
  console.log(`[${verdict}] ${step} — ${evidence}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const require = createRequire(import.meta.url);
const ELECTRON_BIN = require("electron") as unknown as string;

console.log("\n=== INSTÂNCIA ÚNICA: 1ª instância ===");
const { app, page, userDataCopy } = await launchApp();
await waitReady(page);
const titleBefore = await page.title();
console.log(`1ª instância pronta · userDataCopy=${userDataCopy} · title="${titleBefore}"`);

console.log("\n=== INSTÂNCIA ÚNICA: lançando 2ª sobre o MESMO --user-data-dir ===");
const secondLog = "/tmp/cm-second-instance.log";
const out = createWriteStream(secondLog);
const second = spawn(
  ELECTRON_BIN,
  ["out/main/index.js", "--no-sandbox", `--user-data-dir=${userDataCopy}`],
  {
    cwd: process.cwd(),
    env: { ...process.env, CM_SCRUB_SECRETS: "1", CM_MCP_EPHEMERAL_PORT: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
second.stdout?.pipe(out);
second.stderr?.pipe(out);

let secondExitCode: number | null = null;
let secondExitSignal: string | null = null;
const exitPromise = new Promise<void>((resolve) => {
  second.on("exit", (code, signal) => {
    secondExitCode = code;
    secondExitSignal = signal;
    resolve();
  });
});

const deadline = Date.now() + 8_000;
while (Date.now() < deadline && secondExitCode === null) {
  await sleep(200);
}
await Promise.race([exitPromise, sleep(500)]);

record(
  "(a) 2ª instância sai (mesmo --user-data-dir, lock ativo)",
  secondExitCode === 0 ? "PASS" : "FAIL",
  `exitCode=${secondExitCode} signal=${secondExitSignal} log=${secondLog}`,
);

// --- (b) 1ª janela continua viva e responde --------------------------------
let titleAfter = "";
let titleOk = false;
try {
  titleAfter = await page.title();
  titleOk = true;
} catch (err) {
  titleAfter = err instanceof Error ? err.message : String(err);
}
record(
  "(b) 1ª janela continua viva (page.title() responde)",
  titleOk ? "PASS" : "FAIL",
  `title="${titleAfter}"`,
);

// --- (c) foco: document.hasFocus() ou win.isFocused() ----------------------
let hasFocusDom = false;
try {
  hasFocusDom = await page.evaluate(() => document.hasFocus());
} catch {
  // ignora — melhor esforço
}
let winFocused: boolean | null = null;
try {
  winFocused = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return w ? w.isFocused() : null;
  });
} catch {
  // best-effort: ambiente sem WM pode não reportar foco real
}
record(
  "(c) 1ª janela em foco após 2ª tentativa (document.hasFocus / win.isFocused)",
  hasFocusDom || winFocused === true ? "PASS" : "FAIL",
  `document.hasFocus()=${hasFocusDom} win.isFocused()=${winFocused}`,
);

const shot01 = await screenshot(page, "single-instance-01");
console.log(`screenshot: ${shot01}`);

if (!existsSync(secondLog)) console.log("(sem log da 2ª instância)");

await app.close();

console.log("\n=== RESUMO ===");
for (const r of report) console.log(`${r.verdict.padEnd(6)} ${r.step}`);
const failed = report.some((r) => r.verdict === "FAIL");
console.log(failed ? "VALIDATE-SINGLE-INSTANCE FAILED" : "VALIDATE-SINGLE-INSTANCE DONE");
process.exit(failed ? 1 : 0);
