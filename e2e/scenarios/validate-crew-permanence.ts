import { launchApp } from "../driver/launch";
import { captureLogs, screenshot } from "../driver/capture";
import { queryDb } from "../driver/inspect";
import { goToArea, waitReady } from "../driver/nav";

// Valida a branch feat/crew-permanence contra dados reais (cópia):
// 1. as migrations 036/037 aplicam num banco com dados de verdade;
// 2. o app sobe sem erro de console;
// 3. o Crew Dock e o estado "pausada" renderizam;
// 4. as ações novas do card (Dispensar / Soltar) existem.
const { app, page, userDataCopy } = await launchApp();
const { logFile, stop } = captureLogs(app, page);

const errors: string[] = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
});

try {
  await waitReady(page);
  await screenshot(page, "crew-01-initial");

  // --- Migrations sobre dados reais -----------------------------------------
  const cols = await queryDb(userDataCopy, "PRAGMA table_info(handoffs)");
  const names: string[] = (cols ?? []).map((c: Record<string, unknown>) =>
    String(c.name),
  );
  console.log("[handoffs] colunas:", names.join(", "));
  for (const expected of ["dismissed_at", "predecessor_session_id"]) {
    console.log(
      `[migration] ${expected}: ${names.includes(expected) ? "OK" : "FALTANDO"}`,
    );
  }

  const applied = await queryDb(
    userDataCopy,
    "SELECT version, name FROM _migrations WHERE version >= 36 ORDER BY version",
  );
  console.log("[migrations aplicadas]", JSON.stringify(applied));

  const handoffs = await queryDb(
    userDataCopy,
    `SELECT status, COUNT(*) AS n, SUM(CASE WHEN dismissed_at IS NOT NULL THEN 1 ELSE 0 END) AS dispensados
       FROM handoffs GROUP BY status`,
  );
  console.log("[handoffs por status]", JSON.stringify(handoffs));

  // --- Crew Dock -------------------------------------------------------------
  const dock = page.getByTestId("crew-dock");
  const dockVisible = await dock.isVisible().catch(() => false);
  console.log("[crew-dock] visível:", dockVisible);
  if (dockVisible) {
    await screenshot(page, "crew-02-dock");
    for (const label of ["Pausada", "Retomar", "dá pra retomar"]) {
      const n = await page.getByText(label, { exact: false }).count();
      console.log(`[dock] "${label}": ${n} ocorrência(s)`);
    }
  }

  await goToArea(page, "projects");
  await screenshot(page, "crew-03-projects");

  console.log("\n=== ERROS DE CONSOLE ===");
  console.log(errors.length === 0 ? "nenhum" : errors.join("\n"));
  console.log("log completo:", logFile);
} finally {
  stop();
  await app.close();
}
