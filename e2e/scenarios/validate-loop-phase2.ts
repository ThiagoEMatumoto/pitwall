/**
 * Fase 2 do loop: MCP tools + export do doc pro repo.
 *
 * Um único launch cobre os tres passos:
 *  2. app sobe sem regressao (Features abre, dossie abre com pulso/liveness, 0 erro)
 *  3. o servidor MCP embutido serve as 8 tools novas (tools/list + tools/call reais)
 *     e o `initialize` entrega as instructions com a disciplina do loop
 *  4. exportLoopDoc escreve `<repo>/.pitwall/loop-<slug>.md` de forma deterministica
 *
 * O repo alvo do export e um git descartavel no scratchpad — nunca um repo real.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { launchApp } from "../driver/launch";
import { captureLogs, screenshot } from "../driver/capture";
import { goToArea, waitReady } from "../driver/nav";
import { queryDb } from "../driver/inspect";

const THROWAWAY_REPO =
  "/tmp/claude-1000/-home-thiagoematumoto-projetos-pessoal-claude-manager/479aebb8-b6b9-4675-9164-a31d56f3386f/scratchpad/loop-repo";

const ALVO = "Protocolo de peer messaging";

const LOOP_TOOLS = [
  "feature_health_get",
  "feature_pulse_set",
  "feature_pulse_history",
  "feature_ledger_append",
  "feature_ledger_list",
  "feature_metric_declare",
  "feature_metric_record",
  "feature_loop_export",
];

const log = (m: string) => console.log(`[loop2] ${m}`);
let ok = true;
const check = (label: string, cond: boolean, extra = "") => {
  if (!cond) ok = false;
  log(`${cond ? "OK  " : "FALHA"} ${label}${extra ? " :: " + extra : ""}`);
};

const rendererErrors: string[] = [];

const { app, page, userDataCopy } = await launchApp();
const { logFile, stop } = captureLogs(app, page);
const shots: string[] = [];
const shot = async (name: string) => {
  shots.push(await screenshot(page, name));
};

page.on("pageerror", (e) => rendererErrors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") rendererErrors.push(`console.error: ${m.text()}`);
});

// ---- helper MCP ----
let rpcId = 0;
async function mcp(method: string, params?: unknown): Promise<any> {
  const raw = readFileSync(join(userDataCopy, "mcp.json"), "utf8");
  const info = JSON.parse(raw) as { url: string; token: string };
  const res = await fetch(info.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${info.token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: params ?? {} }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  // Streamable HTTP pode responder JSON puro ou SSE.
  if (text.startsWith("event:") || text.includes("\ndata: ")) {
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    if (!line) throw new Error(`SSE sem data: ${text.slice(0, 200)}`);
    return JSON.parse(line.slice(6));
  }
  return JSON.parse(text);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await mcp("tools/call", { name, arguments: args });
  if (res.error) throw new Error(`${name} → ${JSON.stringify(res.error)}`);
  const content = res.result?.content?.[0];
  if (res.result?.isError) throw new Error(`${name} isError → ${content?.text}`);
  return JSON.parse(content.text);
}

let exportedPath = "";

try {
  // ================= PASSO 2 — app sobe, Features abre =================
  await waitReady(page);
  await goToArea(page, "features");
  await page.waitForTimeout(2000);
  await shot("loop2-01-features");

  // Mesma feature-alvo da Fase 1, escopada na sidebar (ver nota no cenario da Fase 1).
  const sidebar = page.locator("aside").first();
  await sidebar.getByText(ALVO, { exact: false }).first().click();

  const doc = page.locator("header").filter({ has: page.locator("h1") }).first();
  await doc.locator("h1").waitFor({ state: "visible", timeout: 20_000 });
  const tituloAberto = (await doc.locator("h1").innerText()).trim();
  log(`dossie aberto: ${JSON.stringify(tituloAberto)}`);
  const docText = await doc.innerText();
  check(
    "chip de liveness presente (Fase 1 viva)",
    /vivo|silêncio|silencio|quebrado|pausado|conclu/i.test(docText),
    docText.slice(0, 120).replace(/\n/g, " | "),
  );
  check("seção de pulso presente", /pulso/i.test(docText));
  check("abriu a feature alvo", tituloAberto.includes(ALVO));
  await shot("loop2-02-dossier");

  // ================= PASSO 3 — MCP serve as tools =================
  const mcpInfo = JSON.parse(readFileSync(join(userDataCopy, "mcp.json"), "utf8"));
  log(`mcp.json da copia: url=${mcpInfo.url} pid=${mcpInfo.pid}`);

  const listed = await mcp("tools/list");
  if (listed.error) throw new Error(`tools/list → ${JSON.stringify(listed.error)}`);
  const names: string[] = (listed.result?.tools ?? []).map((t: any) => t.name);
  log(`tools/list devolveu ${names.length} tools`);
  const faltando = LOOP_TOOLS.filter((n) => !names.includes(n));
  check("as 8 tools do loop aparecem em tools/list", faltando.length === 0, `faltando: ${faltando.join(", ") || "nenhuma"}`);

  // Quem entrega SERVER_INSTRUCTIONS (services/mcp/instructions.ts) e a resposta
  // do `initialize` — nao o import. So o wire prova que a sessao recebe o texto.
  const init = await mcp("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "loop-verifier", version: "0" },
  });
  const instructions: string = init.result?.instructions ?? "";
  log(`initialize → instructions com ${instructions.length} chars`);
  check("initialize devolve instructions", instructions.length > 0);
  const loopIdx = instructions.indexOf("Loop discipline");
  check("instructions trazem o paragrafo 'Loop discipline'", loopIdx >= 0);
  const paragrafo = loopIdx >= 0 ? instructions.slice(loopIdx, instructions.indexOf("\n", loopIdx)) : "";
  if (paragrafo) log(`----8<----\n${paragrafo}\n----8<----`);
  check("o paragrafo manda LER com feature_health_get ao pegar a feature", /feature_health_get/.test(paragrafo));
  check(
    "o paragrafo manda ESCREVER pulso e ledger ao concluir",
    /feature_pulse_set/.test(paragrafo) && /feature_ledger_append/.test(paragrafo),
  );

  // Uma feature real da copia (lida do app.db — linhas pre-existentes, fora do WAL).
  const feats = await queryDb<{ id: string; project_id: string; title: string }>(
    userDataCopy,
    "SELECT id, project_id, title FROM features WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT 1",
  );
  const feat = feats[0];
  if (!feat) throw new Error("nenhuma feature na copia do banco");
  log(`feature real: ${feat.id} ${JSON.stringify(feat.title)}`);

  const health = await callTool("feature_health_get", { featureId: feat.id });
  log(`feature_health_get → ${JSON.stringify(health).slice(0, 400)}`);
  check("health traz liveness", typeof health.liveness === "string", String(health.liveness));
  check("health traz issues (array)", Array.isArray(health.issues), `n=${health.issues?.length}`);
  check("health traz o campo pulse", "pulse" in health, JSON.stringify(health.pulse));
  check("health traz metrics (array)", Array.isArray(health.metrics));

  const PULSO_MCP = "Pulso gravado pela tool MCP feature_pulse_set na validacao da Fase 2.";
  const setRes = await callTool("feature_pulse_set", { featureId: feat.id, body: PULSO_MCP });
  log(`feature_pulse_set → ${JSON.stringify(setRes)}`);
  check("pulse_set devolveu o pulso", setRes.pulse?.body === PULSO_MCP);
  check("pulse_set gravou source=mcp", setRes.pulse?.source === "mcp", String(setRes.pulse?.source));

  // Confirmacao independente COM O APP VIVO (o WAL nao chegou ao app.db ainda).
  const health2 = await callTool("feature_health_get", { featureId: feat.id });
  check("health relido enxerga o pulso novo", health2.pulse?.body === PULSO_MCP, String(health2.pulse?.body).slice(0, 80));
  const hist = await callTool("feature_pulse_history", { featureId: feat.id, limit: 5 });
  check("pulse_history tem o pulso no topo", hist.items?.[0]?.body === PULSO_MCP, `n=${hist.items?.length}`);
  await shot("loop2-03-after-mcp-pulse");

  // ================= PASSO 4 — export escreve no repo =================
  const repos = await queryDb<{ id: string }>(userDataCopy, "SELECT id FROM repos LIMIT 1");
  const repoId = repos[0]?.id;
  if (!repoId) throw new Error("nenhum repo na copia do banco");
  log(`repoId emprestado (worktree_path aponta pro descartavel): ${repoId}`);

  const created = await callTool("feature_create", {
    projectId: feat.project_id,
    title: "Validacao export loop fase 2",
    objective: "Provar que o doc do loop e escrito no repo",
    repos: [{ repoId, branch: null, worktreePath: THROWAWAY_REPO }],
  });
  const novaId = created.feature?.id as string;
  const slug = created.feature?.slug as string;
  log(`feature criada: id=${novaId} slug=${slug}`);
  check("feature de teste criada", Boolean(novaId && slug));

  await callTool("feature_pulse_set", { featureId: novaId, body: "Export do loop sendo validado agora." });
  await callTool("feature_ledger_append", {
    featureId: novaId,
    entryId: "export-doc",
    title: "Export deterministico",
    kind: "shipped",
    body: "Dois exports seguidos precisam dar bytes identicos.",
  });
  await callTool("feature_metric_declare", {
    featureId: novaId,
    columnKey: "p95_ms",
    label: "Latencia p95",
    unit: "ms",
    target: 100,
    isHeadline: true,
  });
  await callTool("feature_metric_record", { featureId: novaId, columnKey: "p95_ms", value: 87, at: 1750000000000, note: "medicao fixa" });

  const dry = await callTool("feature_loop_export", { featureId: novaId, dryRun: true });
  log(`export dryRun → ${JSON.stringify(dry)}`);
  check("dryRun resolve o alvo dentro do repo descartavel", (dry.written ?? []).some((p: string) => p.startsWith(THROWAWAY_REPO)), JSON.stringify(dry.written));
  check("dryRun nao criou nada no disco", !existsSync(join(THROWAWAY_REPO, ".pitwall")));

  const exp1 = await callTool("feature_loop_export", { featureId: novaId });
  log(`export #1 → ${JSON.stringify(exp1)}`);
  exportedPath = join(THROWAWAY_REPO, ".pitwall", `loop-${slug}.md`);
  check("export #1 reportou o path esperado", (exp1.written ?? []).includes(exportedPath), JSON.stringify(exp1.written));
  check("arquivo existe no disco", existsSync(exportedPath));
  const bytes1 = readFileSync(exportedPath);
  log(`conteudo (${bytes1.length} bytes):\n----8<----\n${bytes1.toString("utf8")}\n----8<----`);
  const txt = bytes1.toString("utf8");
  check("frontmatter tem slug", txt.includes(`slug: "${slug}"`));
  check("doc tem o pulso", txt.includes("Export do loop sendo validado agora."));
  check("doc tem a entrada do ledger", txt.includes("`export-doc`"));
  check("doc tem a metrica headline", txt.includes("`p95_ms`") && txt.includes("87 ms"));
  check("doc NAO tem carimbo de geracao", !/generated_at|gerado em/i.test(txt));

  await new Promise((r) => setTimeout(r, 1200));
  const exp2 = await callTool("feature_loop_export", { featureId: novaId });
  const bytes2 = readFileSync(exportedPath);
  check("export #2 escreveu o mesmo path", (exp2.written ?? []).includes(exportedPath));
  check("dois exports seguidos = bytes identicos", bytes1.equals(bytes2), `${bytes1.length} vs ${bytes2.length}`);

  // Nada alem do .pitwall/ foi tocado no repo descartavel.
  log(`repo descartavel agora: ${JSON.stringify(readdirSync(THROWAWAY_REPO).sort())}`);
} catch (err) {
  ok = false;
  log(`ERRO: ${(err as Error).stack ?? (err as Error).message}`);
  await screenshot(page, "loop2-99-error").catch(() => {});
} finally {
  stop();
  await app.close();
}

check(`zero pageerror/console.error no renderer (${rendererErrors.length})`, rendererErrors.length === 0, rendererErrors.slice(0, 5).join(" ;; "));

for (const s of shots) log(`screenshot: ${s}`);
log(`log: ${logFile}`);
log(`export: ${exportedPath}`);
log(ok ? "RESULTADO: PASS" : "RESULTADO: FAIL");
process.exit(ok ? 0 : 1);
