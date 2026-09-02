// Final visual evidence for the Design Studio, in the built app against a
// copy of the real data: the Breads do Breno document built through MCP, the
// in-place "Claude is editing" indicator, Home at 100%, the preview walk, the
// inspector + Layers, the composer and the Design area under all 4 themes.
//
//   npm run rebuild:native && npm run build
//   npx tsx e2e/scenarios/validate-design-final.ts
import { join } from "node:path";
import { launchApp, REPO_ROOT } from "../driver/launch";
import { captureLogs, screenshot } from "../driver/capture";
import { goToArea, waitReady } from "../driver/nav";
import { connectMcp } from "../driver/mcp";
import { makeChecker } from "../driver/design";
import { buildDocument, LINK_COUNT } from "./validate-design-final/build";
import { SHOT, type FinalCtx } from "./validate-design-final/ctx";
import { writeGallery } from "./validate-design-final/gallery";
import { stepAgentInPlace } from "./validate-design-final/steps-agent";
import {
  stepComposer,
  stepHomeAt100,
  stepInspectorLayers,
  stepPreviewFlow,
  stepThemes,
} from "./validate-design-final/steps-user";

const SHOTS_DIR = join(REPO_ROOT, ".cm-drive", "screenshots");

const { checks, log, check, step } = makeChecker(SHOT);
const { app, page, userDataCopy } = await launchApp();
const { logFile, stop } = captureLogs(app, page);
const consoleErrors: string[] = [];
const failedRequests: string[] = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) =>
  consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`),
);
page.on("requestfailed", (r) =>
  failedRequests.push(`${r.failure()?.errorText ?? "?"} ${r.url()}`),
);

try {
  await waitReady(page);
  await goToArea(page, "design");
  await page.waitForTimeout(800);
  const mcp = await connectMcp(userDataCopy);

  // 1. document via MCP, opened in the UI, fit
  const doc = await buildDocument(mcp);
  check(
    "1 document built: 4 artboards, no sanitizer warnings",
    doc.warnings.length === 0,
    doc.warnings.join(" | "),
  );
  check(
    `1 prototype links set (${LINK_COUNT})`,
    doc.links === LINK_COUNT,
    `links=${doc.links}`,
  );
  const ctx: FinalCtx = { page, mcp, doc, check, log };

  const docRow = page.getByText("Breads do Breno").first();
  await page.waitForTimeout(1200);
  if (!(await docRow.isVisible().catch(() => false))) {
    log("UX: new doc not listed without navigation; re-entering the area");
    await goToArea(page, "projects");
    await goToArea(page, "design");
  }
  await docRow.waitFor({ state: "visible", timeout: 10_000 });
  await docRow.click();
  await page.waitForTimeout(2500);
  await page.getByTitle("Ajustar à tela (Ctrl+0)").click();
  await page.waitForTimeout(1500);
  await screenshot(page, `${SHOT}-01-canvas`);
  const boards = await page.locator("[data-artboard]").count();
  check("1 canvas shows the 4 artboards", boards === 4, `count=${boards}`);

  // 2. in-place indicator through real tool calls
  await step("2 agent in-place indicator", async () => {
    await stepAgentInPlace(ctx);
  });

  // 3-6. the designer's view
  await step("3 home at 100%", () => stepHomeAt100(ctx));
  await step("4 preview flow", () => stepPreviewFlow(ctx));
  await step("5 inspector + layers", () => stepInspectorLayers(ctx));
  await step("5 composer", () => stepComposer(ctx));
  await step("6 themes", () => stepThemes(ctx));

  // 7. hygiene
  const unique = [...new Set(consoleErrors)];
  check(
    "7 0 console errors",
    unique.length === 0,
    `${unique.length}: ${JSON.stringify(unique.slice(0, 5))}`,
  );
  check(
    "7 0 requestfailed",
    failedRequests.length === 0,
    `${failedRequests.length}: ${JSON.stringify(failedRequests.slice(0, 5))}`,
  );
} catch (err) {
  check(
    "scenario",
    false,
    String(err instanceof Error ? (err.stack ?? err.message) : err).slice(
      0,
      1200,
    ),
  );
} finally {
  stop();
  await app.close();
}

log("gallery:", writeGallery(SHOTS_DIR));
log("log file:", logFile);
const failed = checks.filter((c) => !c.ok);
log(`${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
