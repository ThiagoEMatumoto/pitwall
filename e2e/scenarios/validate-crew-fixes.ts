import { launchApp } from "../driver/launch";
import { captureLogs, screenshot } from "../driver/capture";
import { waitReady } from "../driver/nav";

// Valida os dois fixes de sessões filhas. Roda contra um perfil SEMEADO
// (CM_REAL_USERDATA) com 3 cards ativos — o userData real só tem handoffs em
// estado terminal, então o dock viria vazio e nada seria exercido.
//
// (1) dispensa: o "×" no card e Delete no dock removem em um gesto, com Desfazer.
// (2) atlas: abrir o peek em modo terminal monta um Terminal novo. Antes do fix
//     isso limpava a textura compartilhada e corrompia as OUTRAS panes. Comparamos
//     o canvas das panes de fundo antes/depois — elas não recebem input nenhum,
//     então qualquer mudança de pixel é corrupção.
const { app, page } = await launchApp();
const { stop } = captureLogs(app, page);

async function paneSignature() {
  return page.evaluate(() => {
    const canvases = Array.from(
      document.querySelectorAll(".xterm canvas"),
    ) as HTMLCanvasElement[];
    return canvases
      .filter((c) => c.width > 200 && c.height > 100)
      .map((c) => {
        try {
          return { w: c.width, h: c.height, sig: c.toDataURL().slice(-3000) };
        } catch {
          return { w: c.width, h: c.height, sig: "unreadable" };
        }
      });
  });
}

async function dockState() {
  return page.evaluate(() => {
    const cards = Array.from(
      document.querySelectorAll("[data-crew-card]"),
    ) as HTMLElement[];
    return {
      count: cards.length,
      ids: cards.map((c) => c.getAttribute("data-crew-card") || "?"),
      // botão de dispensar DENTRO de um card (exclui os "×" dos toasts)
      dismissBtns: cards.filter((c) =>
        c.querySelector('[aria-label="Dispensar"]'),
      ).length,
      texts: cards.map((c) => (c.textContent || "").trim().slice(0, 40)),
    };
  });
}

try {
  await waitReady(page);
  const skip = page.getByText("PULAR INTRO", { exact: false });
  if (await skip.count()) {
    await skip.first().click();
    await page.waitForTimeout(1200);
  }
  const session = page.getByText("leia", { exact: true });
  if (await session.count()) {
    await session.first().click();
    await page.waitForTimeout(3000);
  }
  await screenshot(page, "crew-00-inicial");

  // ---------------- Parte 1: dispensa ----------------
  let dock = await dockState();
  console.log("=== dock inicial ===");
  console.log(JSON.stringify(dock, null, 2));

  if (dock.count === 0) {
    console.log("\nINCONCLUSIVO — dock vazio; o seed não chegou na cópia.");
    process.exitCode = 1;
  } else {
    // 1a) botão "×" dispensa em um clique
    const firstId = dock.ids[0];
    const btn = page
      .locator(`[data-crew-card="${firstId}"] [aria-label="Dispensar"]`)
      .first();
    const hasBtn = (await btn.count()) > 0;
    console.log(`\nbotão "×" presente no card: ${hasBtn}`);
    if (hasBtn) {
      await btn.click();
      await page.waitForTimeout(1200);
      const afterClick = await dockState();
      console.log(
        `após clicar "×": ${dock.count} -> ${afterClick.count} cards ${
          afterClick.count === dock.count - 1 ? "(OK)" : "(FALHOU)"
        }`,
      );
      await screenshot(page, "crew-01-apos-dispensar");

      // 1b) toast "Desfazer" restaura
      const undo = page.getByRole("button", { name: /desfazer/i });
      const hasUndo = (await undo.count()) > 0;
      console.log(`toast "Desfazer" presente: ${hasUndo}`);
      if (hasUndo) {
        await undo.first().click();
        await page.waitForTimeout(1200);
        const afterUndo = await dockState();
        console.log(
          `após "Desfazer": ${afterUndo.count} cards ${
            afterUndo.count === dock.count ? "(RESTAUROU)" : "(NÃO restaurou)"
          }`,
        );
        await screenshot(page, "crew-02-apos-desfazer");
      }
    }

    // 1c) Delete no dock dispensa o card sob o cursor
    dock = await dockState();
    await page.keyboard.press("Control+j");
    await page.waitForTimeout(700);
    await page.keyboard.press("Delete");
    await page.waitForTimeout(1200);
    const afterKey = await dockState();
    console.log(
      `\nDelete no dock: ${dock.count} -> ${afterKey.count} cards ${
        afterKey.count < dock.count ? "(OK)" : "(sem efeito)"
      }`,
    );
    await screenshot(page, "crew-03-apos-delete");
  }

  // ---------------- Parte 2: atlas ----------------
  const before = await paneSignature();
  console.log(`\n=== atlas: ${before.length} canvas de terminal medidos ===`);

  const cards = await dockState();
  if (cards.count > 0) {
    // "Espiar" abre o peek (overlay, sem mexer no layout das panes de fundo).
    const peek = page.getByRole("button", { name: /espiar/i });
    if (await peek.count()) {
      await peek.first().click();
      await page.waitForTimeout(2000);
    }
    await screenshot(page, "crew-04-peek-aberto");

    // Só os botões DENTRO do overlay: o resto da UI fica atrás dele e o clique
    // seria interceptado.
    const overlay = page.locator('div.fixed.inset-0[class*="z-[1000]"]').first();
    const btns = await overlay.evaluate((root) =>
      Array.from(root.querySelectorAll("button"))
        .map((b) => (b.textContent || b.getAttribute("aria-label") || "").trim())
        .filter(Boolean)
        .slice(0, 30),
    );
    console.log("botões dentro do peek:", JSON.stringify(btns));

    // Dentro do peek, ir pro modo terminal: é o que monta o Terminal novo e
    // dispara o clearTextureAtlas do mount — o caminho do bug.
    const term = overlay.getByRole("button", { name: /terminal/i });
    if (await term.count()) {
      await term.first().click();
      console.log("modo Terminal acionado no peek");
      await page.waitForTimeout(3500);
      const mounted = await overlay.locator(".xterm").count();
      console.log(`terminais montados dentro do peek: ${mounted}`);
    } else {
      console.log("AVISO: nenhum botão de terminal encontrado DENTRO do peek");
    }
    await screenshot(page, "crew-05-peek-terminal");

    await page.keyboard.press("Escape");
    await page.waitForTimeout(1500);
  }
  await screenshot(page, "crew-06-final");

  const after = await paneSignature();
  let changed = 0;
  let compared = 0;
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    if (before[i].w !== after[i].w || before[i].h !== after[i].h) continue;
    compared++;
    if (before[i].sig !== after[i].sig) changed++;
  }
  console.log(
    `panes de fundo comparadas: ${compared} | alteradas sem input: ${changed} (esperado 0)`,
  );

  console.log("\n================ VEREDITO ================");
  if (compared === 0) {
    console.log("INCONCLUSIVO — nenhuma pane de fundo pôde ser comparada.");
    process.exitCode = 1;
  } else if (changed > 0) {
    console.log(`FAIL — ${changed} pane(s) de fundo corrompidas pelo peek.`);
    process.exitCode = 1;
  } else {
    console.log(
      `PASS — ${compared} panes de fundo intactas após abrir o peek.`,
    );
  }
} finally {
  stop();
  await app.close();
}
