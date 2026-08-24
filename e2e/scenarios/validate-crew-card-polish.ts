import { launchApp } from "../driver/launch";
import { captureLogs, screenshot } from "../driver/capture";
import { waitReady } from "../driver/nav";

// Acabamento do card pausado: (1) "Ver motivo" na linha do estado, sem link
// órfão e sem colisão com o menu de overflow; (2) ícone de pause nítido.
const { app, page } = await launchApp();
const { logFile, stop } = captureLogs(app, page);

const errors: string[] = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  const splash = page.locator(".spl-root");
  const sawSplash = await splash
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (sawSplash) {
    await page
      .locator('.spl-toggle input[type="checkbox"]')
      .check()
      .catch(() => {});
    await page.locator(".spl-skip").click();
    await splash
      .waitFor({ state: "detached", timeout: 15_000 })
      .catch(async () => {
        await page.keyboard.press("Escape");
        await splash.waitFor({ state: "detached", timeout: 10_000 });
      });
  }
  await waitReady(page);
  await sleep(1500);

  const dock = page.getByTestId("crew-dock");
  if ((await dock.count()) === 0) throw new Error("crew-dock não montou");
  if ((await dock.getAttribute("data-expanded")) !== "true") {
    await dock.locator("button").first().click();
    await sleep(800);
  }
  await sleep(600);
  await dock.screenshot({
    path: ".cm-drive/screenshots/fix-01-dock-closeup.png",
  });
  console.log("=== TEXTO DO DOCK ===\n" + (await dock.innerText()) + "\n=====");

  // Menu aberto: o gatilho do motivo subiu, então nada fica debaixo do painel.
  const more = dock.getByLabel("Mais ações");
  if ((await more.count()) > 0) {
    await more.first().click();
    await sleep(500);
    await screenshot(page, "fix-02-card-menu");
    await page.keyboard.press("Escape");
    await sleep(400);
  }

  // Disclosure: o <pre> do motivo tem que abrir logo abaixo do bloco de estado.
  const motivo = dock.getByRole("button", { name: "Ver motivo" });
  console.log('[card] gatilho "Ver motivo":', await motivo.count());
  if ((await motivo.count()) > 0) {
    await motivo.first().click();
    await sleep(500);
    await dock.screenshot({
      path: ".cm-drive/screenshots/fix-03-motivo-aberto.png",
    });
    console.log(
      '[card] "Ocultar" visível:',
      await dock.getByText("Ocultar").count(),
    );
  }

  console.log("\n=== ERROS DE CONSOLE ===");
  console.log(errors.length === 0 ? "nenhum" : errors.join("\n"));
  console.log("log completo:", logFile);
} finally {
  stop();
  await app.close();
}
