/**
 * Fase 1 do loop da feature: pulso (frase ≤200 ch) + liveness derivado.
 *
 * Fluxo completo pela UI: abre Features, seleciona uma feature pelo nome, abre o
 * editor de pulso, escreve, salva, confirma na tela, reedita (segundo pulso, pra
 * o histórico ter o que mostrar) e abre o disclosure "histórico".
 *
 * Duas armadilhas que este cenário evita de propósito:
 *
 * 1. SELETOR DE TEXTO SEM ESCOPO. A sidebar lista features cujo TÍTULO contém
 *    "salvar" (ex.: "Erro ao salvar peça com nome duplicado"), então
 *    `getByRole('button', { name: /salvar/i }).first()` casa com um item da
 *    sidebar e TROCA a feature aberta em vez de salvar o pulso. Aqui a sidebar é
 *    escopada em `aside` e o dossiê no `header` que contém o h1; o botão é
 *    pedido pelo nome exato "Salvar pulso".
 *
 * 2. LER O BANCO COM O APP VIVO. O app usa SQLite em WAL e `queryDb` (sql.js) lê
 *    só `app.db` — a linha recém-gravada ainda está no `-wal` e a consulta volta
 *    vazia. A verificação de banco fica DEPOIS de `app.close()`.
 */
import { launchApp } from "../driver/launch";
import { captureLogs, screenshot } from "../driver/capture";
import { goToArea, waitReady } from "../driver/nav";
import { queryDb } from "../driver/inspect";

const ALVO = "Protocolo de peer messaging";
const PULSO_1 =
  "Fase 1 do loop no ar: pulso e liveness aparecem no dossie da feature.";
const PULSO_2 =
  "Segundo pulso — o anterior deve descer para o historico, sem sobrescrever.";

const { app, page, userDataCopy } = await launchApp();
const { logFile, stop } = captureLogs(app, page);
const log = (m: string) => console.log(`[loop] ${m}`);
const shots: string[] = [];
const shot = async (name: string) => {
  shots.push(await screenshot(page, name));
};

page.on("pageerror", (e) => log(`PAGEERROR: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") log(`CONSOLE.ERROR: ${m.text()}`);
});

let ok = true;
const check = (label: string, cond: boolean) => {
  if (!cond) ok = false;
  log(`${cond ? "OK  " : "FALHA"} ${label}`);
};

try {
  await waitReady(page);
  await goToArea(page, "features");
  await page.waitForTimeout(1500);
  await shot("loop-01-features-list");

  // --- seleciona a feature: escopo na sidebar, nunca na página inteira ---
  const sidebar = page.locator("aside").first();
  await sidebar.getByText(ALVO, { exact: false }).first().click();

  // O dossiê é o <header> que contém o h1 do título — escopo estável pro pulso,
  // o histórico e o chip de liveness, todos renderizados por FeatureDoc ali.
  const doc = page
    .locator("header")
    .filter({ has: page.locator("h1") })
    .first();
  const titulo = doc.locator("h1");
  await titulo.waitFor({ state: "visible", timeout: 15_000 });
  const tituloAberto = (await titulo.innerText()).trim();
  log(`dossiê aberto: ${JSON.stringify(tituloAberto)}`);
  check("abriu a feature alvo", tituloAberto.includes(ALVO));
  await shot("loop-02-dossier");

  const liveness = await doc.innerText();
  check(
    "chip de liveness presente",
    /vivo|silêncio|quebrado|pausado|concluído/i.test(liveness),
  );

  // --- escreve o primeiro pulso ---
  await doc
    .getByText(/sem pulso/i)
    .first()
    .click();
  const editor = doc.getByRole("textbox", { name: "Pulso da feature" });
  await editor.waitFor({ state: "visible", timeout: 5_000 });
  await editor.fill(PULSO_1);
  const contador = doc.getByTestId("pulse-counter");
  log(`contador: ${(await contador.innerText()).trim()}`);
  check(
    "contador mostra o limite de 200",
    (await contador.innerText()).includes("/200"),
  );
  await shot("loop-03-pulse-editor");

  const salvar = doc.getByRole("button", { name: "Salvar pulso", exact: true });
  check(
    'existe exatamente um botão "Salvar pulso"',
    (await salvar.count()) === 1,
  );
  await salvar.click();

  // Evidência positiva na UI: o texto gravado tem que aparecer no dossiê.
  await doc
    .getByText(PULSO_1, { exact: false })
    .waitFor({ state: "visible", timeout: 10_000 });
  const posSalvar = await doc.innerText();
  check("pulso visível no dossiê", posSalvar.includes(PULSO_1));
  check('"sem pulso" sumiu', !/sem pulso/i.test(posSalvar));
  check(
    'chip de origem "você"',
    (await doc.getByTestId("pulse-source").count()) === 1,
  );
  await shot("loop-04-pulse-saved");

  // --- segundo pulso pelo lápis: append-only, o primeiro desce pro histórico ---
  await doc.getByTitle("Editar pulso").click();
  await editor.waitFor({ state: "visible", timeout: 5_000 });
  await editor.fill(PULSO_2);
  await doc.getByRole("button", { name: "Salvar pulso", exact: true }).click();
  await doc
    .getByText(PULSO_2, { exact: false })
    .waitFor({ state: "visible", timeout: 10_000 });
  check("segundo pulso vigente", (await doc.innerText()).includes(PULSO_2));

  // --- histórico ---
  await doc.getByRole("button", { name: /histórico/i }).click();
  const entradas = doc.getByTestId("pulse-entry");
  await entradas.first().waitFor({ state: "visible", timeout: 10_000 });
  const n = await entradas.count();
  log(`entradas no histórico: ${n}`);
  check(
    "histórico traz o pulso anterior",
    (await entradas.first().innerText()).includes(PULSO_1),
  );
  check(
    "vigente não se repete no histórico",
    !(await entradas.first().innerText()).includes(PULSO_2),
  );
  await shot("loop-05-history-open");
} catch (err) {
  ok = false;
  log(`ERRO: ${(err as Error).message}`);
  await screenshot(page, "loop-99-error").catch(() => {});
} finally {
  stop();
  await app.close();
}

// Só agora: com o app fechado o WAL foi materializado no app.db da cópia e o
// sql.js do queryDb enxerga as linhas (ver nota em e2e/driver/inspect.ts).
const rows = await queryDb<{ body: string; source: string }>(
  userDataCopy,
  "SELECT body, source FROM feature_pulses ORDER BY created_at ASC, rowid ASC",
);
log(`feature_pulses (pós-close): ${JSON.stringify(rows)}`);
check("banco tem os dois pulsos", rows.length === 2);
check("append-only preservou o primeiro", rows[0]?.body === PULSO_1);
check(
  "segundo pulso gravado como human",
  rows[1]?.body === PULSO_2 && rows[1]?.source === "human",
);

// Colunas novas da migration 042.
const cols = await queryDb<{ name: string }>(
  userDataCopy,
  "SELECT name FROM pragma_table_info('features') WHERE name IN ('cadence_days','loop_export')",
);
check("migration 042 aplicada em features", cols.length === 2);

for (const s of shots) log(`screenshot: ${s}`);
log(`log: ${logFile}`);
log(ok ? "RESULTADO: PASS" : "RESULTADO: FAIL");
process.exit(ok ? 0 : 1);
