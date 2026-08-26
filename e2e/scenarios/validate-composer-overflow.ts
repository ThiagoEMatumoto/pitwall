import { launchApp } from "../driver/launch";
import { captureLogs, screenshot } from "../driver/capture";
import { waitReady } from "../driver/nav";

// Valida o overflow progressivo da barra do composer.
// A pergunta que importa não é "o menu apareceu?" e sim "algum controle está
// sendo cortado pela borda do pane?" — que era o bug original. Medimos a borda
// direita de cada controle contra a da barra, em TODAS as barras visíveis (uma
// por pane): medir só a primeira já quase produziu um falso PASS.
const { app, page } = await launchApp();
const { stop } = captureLogs(app, page);

async function setWindowWidth(width: number) {
  await app.evaluate(async ({ BrowserWindow }, w) => {
    const win = BrowserWindow.getAllWindows()[0];
    const [, h] = win.getSize();
    win.setSize(w, h);
  }, width);
  await page.waitForTimeout(700);
}

async function measure(label: string, windowWidth: number) {
  await setWindowWidth(windowWidth);

  // Sem funções nomeadas dentro do evaluate: o esbuild do tsx injeta o helper
  // __name, que não existe no contexto da página.
  const bars = await page.evaluate(() => {
    const found = (
      Array.from(
        document.querySelectorAll("div.flex.items-center.gap-2.px-1.pb-1"),
      ) as HTMLElement[]
    ).filter((b) => b.getBoundingClientRect().width > 0);
    return found.map((bar) => {
      const r = bar.getBoundingClientRect();
      const kids = (Array.from(bar.children) as HTMLElement[]).filter(
        (k) => k.getBoundingClientRect().width > 0,
      );
      return {
        barWidth: Math.round(r.width),
        contentWidth: Math.round(
          Math.max(...kids.map((k) => k.getBoundingClientRect().right)) -
            r.left,
        ),
        controls: kids.length,
        hasMore: Boolean(bar.querySelector('[aria-label="Mais controles"]')),
        labels: kids.map((k) =>
          (k.textContent || k.getAttribute("aria-label") || "·")
            .trim()
            .slice(0, 20),
        ),
        clipped: kids
          .filter((k) => k.getBoundingClientRect().right > r.right + 1)
          .map((k) =>
            (k.textContent || k.getAttribute("aria-label") || "·")
              .trim()
              .slice(0, 20),
          ),
      };
    });
  });

  console.log(
    `\n=== ${label} — janela ${windowWidth}px — ${bars.length} barra(s) ===`,
  );
  for (const b of bars) {
    const verdict = b.clipped.length
      ? `CORTADO: ${JSON.stringify(b.clipped)}`
      : "ok";
    console.log(
      `  pane ${String(b.barWidth).padStart(4)}px | conteudo ${String(b.contentWidth).padStart(4)}px | ` +
        `${b.controls} ctrl${b.hasMore ? " +..." : "    "} | ${verdict}`,
    );
    console.log(`      ${JSON.stringify(b.labels)}`);
  }
  await screenshot(page, `composer-${label}`);
  return bars;
}

try {
  await waitReady(page);
  const skip = page.getByText("PULAR INTRO", { exact: false });
  if (await skip.count()) {
    await skip.first().click();
    await page.waitForTimeout(1200);
  }
  const sessionItem = page.getByText("leia", { exact: true });
  if (await sessionItem.count()) {
    await sessionItem.first().click();
    await page.waitForTimeout(2500);
  }
  await screenshot(page, "composer-00-sessao");

  const all: Record<string, Awaited<ReturnType<typeof measure>>> = {};
  for (const [label, width] of [
    ["janela-larga", 1900],
    ["janela-media", 1400],
    ["janela-estreita", 1000],
  ] as const) {
    all[label] = await measure(label, width);
  }

  console.log("\n================ VEREDITO ================");
  const empty = Object.entries(all).filter(([, bars]) => bars.length === 0);
  const bad = Object.entries(all).filter(([, bars]) =>
    bars.some((b) => b.clipped.length > 0),
  );
  if (empty.length) {
    console.log(
      `INCONCLUSIVO — nenhuma barra medida em: ${empty.map(([l]) => l).join(", ")}`,
    );
    process.exitCode = 1;
  } else if (bad.length) {
    console.log("FAIL — controles cortados:");
    for (const [label, bars] of bad) {
      for (const b of bars.filter((x) => x.clipped.length)) {
        console.log(
          `  ${label}: pane ${b.barWidth}px -> ${JSON.stringify(b.clipped)}`,
        );
      }
    }
    process.exitCode = 1;
  } else {
    const panes = Object.values(all).flat().length;
    console.log(`PASS — ${panes} barras medidas, nenhum controle cortado.`);
  }
} finally {
  stop();
  await app.close();
}
