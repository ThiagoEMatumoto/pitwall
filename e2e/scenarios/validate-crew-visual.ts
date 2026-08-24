import { launchApp } from "../driver/launch";
import { captureLogs, screenshot } from "../driver/capture";
import { goToArea, waitReady } from "../driver/nav";

// Evidência VISUAL da branch feat/crew-permanence: pula a intro do boot e
// captura o Crew Dock realmente visível (card pausado, selo, menu de overflow),
// os botões novos do header de sessão e uma passada de regressão pelas áreas.
const { app, page } = await launchApp();
const { logFile, stop } = captureLogs(app, page);

const errors: string[] = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  // --- 1. Pular a intro -------------------------------------------------------
  const splash = page.locator(".spl-root");
  const sawSplash = await splash
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  console.log("[intro] apareceu:", sawSplash);
  if (sawSplash) {
    // Marca "não mostrar a intro no boot" (persiste na cópia) e pula.
    const dontShow = page.locator('.spl-toggle input[type="checkbox"]');
    await dontShow
      .check()
      .catch(() => console.log("[intro] checkbox não encontrado"));
    await page.locator(".spl-skip").click();
    await splash
      .waitFor({ state: "detached", timeout: 15_000 })
      .catch(async () => {
        // Fallback: alguns modos usam animação de saída antes de desmontar.
        await page.keyboard.press("Escape");
        await splash.waitFor({ state: "detached", timeout: 10_000 });
      });
  }
  await waitReady(page);
  await sleep(1500);
  await screenshot(page, "vis-01-after-intro");

  // --- 2. Crew Dock -----------------------------------------------------------
  const dock = page.getByTestId("crew-dock");
  const dockCount = await dock.count();
  console.log("[dock] montado:", dockCount > 0);
  if (dockCount > 0) {
    let expanded = await dock.getAttribute("data-expanded");
    console.log("[dock] data-expanded inicial:", expanded);
    if (expanded !== "true") {
      await dock.locator("button").first().click();
      await sleep(600);
      expanded = await dock.getAttribute("data-expanded");
      console.log("[dock] data-expanded após clique:", expanded);
    }
    await sleep(800);
    await screenshot(page, "vis-02-dock-expanded");
    await dock.screenshot({
      path: ".cm-drive/screenshots/vis-03-dock-closeup.png",
    });

    const text = await dock.innerText();
    console.log("=== TEXTO DO DOCK ===\n" + text + "\n=====================");

    // --- 3. Menu de overflow do card ------------------------------------------
    const more = dock.getByLabel("Mais ações");
    const moreCount = await more.count();
    console.log('[dock] botões "Mais ações":', moreCount);
    if (moreCount > 0) {
      await more.first().click();
      await sleep(500);
      await screenshot(page, "vis-04-card-menu");
      const items = await page.getByRole("menuitem").allInnerTexts();
      console.log("[menu] itens (role=menuitem):", JSON.stringify(items));
      // Fallback: alguns Menu não usam role=menuitem.
      for (const label of [
        "Dispensar (arquiva o card)",
        "Soltar do painel (desfaz o vínculo)",
        "Forçar falha",
      ]) {
        const n = await page.getByText(label, { exact: false }).count();
        console.log(`[menu] "${label}": ${n}`);
      }
      await page.keyboard.press("Escape");
      await sleep(400);
    }
  }

  // --- 4. Botões novos do header de sessão ------------------------------------
  for (const label of ["Passar o bastão", "Tornar sessão filha"]) {
    const loc = page.getByLabel(label, { exact: false });
    const n = await loc.count();
    const vis =
      n > 0
        ? await loc
            .first()
            .isVisible()
            .catch(() => false)
        : false;
    console.log(`[header] "${label}": count=${n} visível=${vis}`);
  }
  const anyHeader =
    (await page.getByLabel("Passar o bastão", { exact: false }).count()) > 0 ||
    (await page.getByLabel("Tornar sessão filha", { exact: false }).count()) >
      0;
  if (anyHeader) await screenshot(page, "vis-05-session-header");

  // --- 5. Regressão pelas áreas ------------------------------------------------
  for (const area of ["projects", "features", "metrics"] as const) {
    await goToArea(page, area);
    await sleep(1200);
    await screenshot(page, `vis-06-${area}`);
  }

  console.log("\n=== ERROS DE CONSOLE ===");
  console.log(errors.length === 0 ? "nenhum" : errors.join("\n"));
  console.log("log completo:", logFile);
} finally {
  stop();
  await app.close();
}
