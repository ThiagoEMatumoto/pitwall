import { launchApp } from "../driver/launch";
import { captureLogs, screenshot } from "../driver/capture";
import { goToArea, waitReady } from "../driver/nav";
import { skeletonToElements } from "../../shared/diagram-skeleton";

const { app, page } = await launchApp();
const { logFile, stop } = captureLogs(app, page);

function log(...a: unknown[]) {
  console.log("[scenario]", ...a);
}

// Erros de console acumulados — evidência negativa no reporte final.
const consoleErrors: string[] = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(e.message));

// Cena Excalidraw válida gerada pelo conversor real (mesmo caminho do MCP):
// 2 shapes + 1 arrow com labels.
const sceneV1 = skeletonToElements([
  {
    id: "renderer",
    type: "rectangle",
    x: 120,
    y: 120,
    width: 180,
    height: 64,
    label: { text: "Renderer" },
  },
  {
    id: "main",
    type: "rectangle",
    x: 460,
    y: 120,
    width: 180,
    height: 64,
    label: { text: "Main" },
  },
  {
    id: "ipc",
    type: "arrow",
    start: { id: "renderer" },
    end: { id: "main" },
    label: { text: "IPC" },
  },
]);

// Segunda versão: um nó a mais — é o "update ao vivo" vindo de fora.
const sceneV2 = skeletonToElements([
  {
    id: "renderer",
    type: "rectangle",
    x: 120,
    y: 120,
    width: 180,
    height: 64,
    label: { text: "Renderer" },
  },
  {
    id: "main",
    type: "rectangle",
    x: 460,
    y: 120,
    width: 180,
    height: 64,
    label: { text: "Main" },
  },
  {
    id: "db",
    type: "rectangle",
    x: 460,
    y: 300,
    width: 180,
    height: 64,
    label: { text: "SQLite" },
  },
  {
    id: "ipc",
    type: "arrow",
    start: { id: "renderer" },
    end: { id: "main" },
    label: { text: "IPC" },
  },
  {
    id: "sql",
    type: "arrow",
    start: { id: "main" },
    end: { id: "db" },
    label: { text: "sql" },
  },
]);

try {
  await waitReady(page);
  await screenshot(page, "dg-00-boot");

  // 1. Ícone existe e a área abre no estado vazio.
  await goToArea(page, "diagrams");
  await page.waitForTimeout(1200);
  await screenshot(page, "dg-01-empty");
  const emptyAside = await page.locator("aside").first().innerText();
  log("sidebar (vazio):", JSON.stringify(emptyAside.slice(0, 300)));

  // 2. Semear via a bridge real (window.api -> IPC -> store -> broadcast).
  const seeded = await page.evaluate(async (elements) => {
    const api = (window as any).api;
    if (!api?.diagrams) return { error: "window.api.diagrams ausente" };
    try {
      const d = await api.diagrams.create({
        title: "Fluxo IPC (e2e)",
        kind: "flow",
        scene: { elements },
        sourceFormat: "skeleton",
        author: "claude",
        summary: "seed do cenário e2e",
      });
      return {
        id: d.id,
        version: d.version,
        elements: d.scene.elements.length,
      };
    } catch (e) {
      return { error: String((e as Error)?.message ?? e) };
    }
  }, sceneV1 as unknown[]);
  log("seed:", JSON.stringify(seeded));
  if ("error" in seeded) throw new Error(`seed falhou: ${seeded.error}`);

  // 3. O broadcast deve pôr o item na lista; clicar e esperar o editor.
  await page.waitForTimeout(1500);
  await screenshot(page, "dg-02-list");
  const item = page.getByRole("button", { name: /Fluxo IPC \(e2e\)/ }).first();
  await item.click();
  await page
    .locator(".excalidraw")
    .waitFor({ state: "visible", timeout: 30_000 });
  // Dar tempo pro canvas pintar (fontes + primeira render).
  await page.waitForTimeout(2500);
  await screenshot(page, "dg-03-editor");

  // 4. Update ao vivo: segunda cena via bridge com o editor aberto.
  const updated = await page.evaluate(
    async ({ id, elements }) => {
      const api = (window as any).api;
      try {
        const d = await api.diagrams.updateScene({
          id,
          scene: { elements },
          author: "claude",
          summary: "nó SQLite adicionado (e2e)",
          snapshot: true,
        });
        return { version: d.version, elements: d.scene.elements.length };
      } catch (e) {
        return { error: String((e as Error)?.message ?? e) };
      }
    },
    { id: (seeded as { id: string }).id, elements: sceneV2 as unknown[] },
  );
  log("update:", JSON.stringify(updated));

  // Evidência positiva do caminho remoto: o toast "Atualizado pelo Claude".
  const toast = page.getByText("Atualizado pelo Claude").first();
  const toastVisible = await toast
    .waitFor({ state: "visible", timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  log("toast 'Atualizado pelo Claude' visivel:", toastVisible);
  await page.waitForTimeout(800);
  await screenshot(page, "dg-04-live-update");

  // 5. Arquivar pelo menu ⋯ e ver o item sair da lista (filtro default).
  await page.getByTitle("Mais ações", { exact: true }).click();
  await page.getByRole("button", { name: "Arquivar", exact: true }).click();
  await page.waitForTimeout(1200);
  await screenshot(page, "dg-05-archived");
  const asideAfter = await page.locator("aside").first().innerText();
  log("sidebar pos-arquivar:", JSON.stringify(asideAfter.slice(0, 300)));

  log(
    "console errors:",
    consoleErrors.length,
    JSON.stringify(consoleErrors.slice(0, 10)),
  );
  log("logFile:", logFile);
} catch (err) {
  console.error("[scenario] FALHOU:", err);
  try {
    await screenshot(page, "dg-99-error");
  } catch {}
} finally {
  stop();
  await app.close();
}
