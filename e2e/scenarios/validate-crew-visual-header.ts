import { launchApp } from "../driver/launch";
import { captureLogs, screenshot } from "../driver/capture";
import { goToArea, waitReady } from "../driver/nav";

// Segunda passada: os botões novos do header de sessão ("Passar o bastão" e
// "Tornar sessão filha") só existem quando há pane de sessão montado — ou seja,
// na área Projetos, não na Home.
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
  if (
    await splash
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await page.locator(".spl-skip").click();
    await splash
      .waitFor({ state: "detached", timeout: 15_000 })
      .catch(() => {});
  }
  await waitReady(page);
  await goToArea(page, "projects");
  await sleep(4000);

  for (const label of ["Passar o bastão", "Tornar sessão filha"]) {
    const loc = page.getByLabel(label, { exact: false });
    const n = await loc.count();
    console.log(`[header] "${label}": count=${n}`);
    if (n > 0) {
      const first = loc.first();
      console.log(
        `  visível=${await first.isVisible()} title=${await first.getAttribute("title")}`,
      );
    }
  }

  // Recolhe o dock pra dar largura aos panes e deixa só um pane visível seria
  // destrutivo (fechar aba) — em vez disso, recorta o header do pane focado.
  const baton = page.getByLabel("Passar o bastão", { exact: false }).first();
  if ((await baton.count()) > 0) {
    const box = await baton.boundingBox();
    if (box) {
      await page.screenshot({
        path: ".cm-drive/screenshots/vis-07-header-zoom.png",
        clip: {
          x: Math.max(0, box.x - 420),
          y: Math.max(0, box.y - 40),
          width: 700,
          height: 110,
        },
      });
      console.log(
        "[header] recorte salvo em vis-07-header-zoom.png",
        JSON.stringify(box),
      );
    }
    await baton.hover();
    await sleep(900);
    await screenshot(page, "vis-08-header-hover");
  }

  console.log("\n=== ERROS DE CONSOLE ===");
  console.log(errors.length === 0 ? "nenhum" : errors.join("\n"));
  console.log("log:", logFile);
} finally {
  stop();
  await app.close();
}
