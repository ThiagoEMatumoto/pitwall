// Verificação nº4: as 4 MCP tools de content contract, exercitadas pelo SERVIDOR
// MCP HTTP embutido no main do app buildado (não pelo IPC do renderer).
// Porta efêmera (CM_MCP_PORT=0) porque a 41956 está com o app instalado.
process.env.CM_MCP_PORT = "0";

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp } from "../driver/launch";
import { captureLogs } from "../driver/capture";

const { app, page, userDataCopy } = await launchApp();
const { logFile, stop } = captureLogs(app, page);

function log(label: string, value: unknown): void {
  console.log(`\n===== ${label} =====`);
  console.log(
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
  );
}

async function waitForMcpConfig(): Promise<{
  url: string;
  token: string;
  pid: number;
}> {
  const path = join(userDataCopy, "mcp.json");
  for (let i = 0; i < 60; i++) {
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (parsed.url && parsed.token) return parsed;
      } catch {
        // arquivo sendo escrito
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`mcp.json não apareceu em ${path} em 30s`);
}

const info = await waitForMcpConfig();
log("mcp.json (descoberta de endpoint)", {
  url: info.url,
  pid: info.pid,
  tokenLen: info.token.length,
});

let rpcId = 0;
async function rpc(method: string, params?: unknown): Promise<unknown> {
  const body = { jsonrpc: "2.0", id: ++rpcId, method, params };
  const res = await fetch(info.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${info.token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  // Streamable HTTP pode responder JSON puro ou SSE.
  if (text.startsWith("{")) return JSON.parse(text);
  const dataLines = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  return JSON.parse(dataLines[dataLines.length - 1]);
}

// Chamada de tool: devolve o envelope cru do JSON-RPC (inclui isError).
async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  return (await rpc("tools/call", { name, arguments: args })) as any;
}

function parsePayload(envelope: any): any {
  const txt = envelope?.result?.content?.[0]?.text;
  return typeof txt === "string" ? JSON.parse(txt) : txt;
}

const slug = `mcp-e2e-${Date.now()}`;
const results: Record<string, string> = {};

try {
  // --- passo 0: initialize + tools/list ---
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "kz-verifier-raw-http", version: "0.0.1" },
  });
  log("initialize", init);

  const listed = (await rpc("tools/list", {})) as any;
  const tools: Array<{ name: string; description?: string }> =
    listed?.result?.tools ?? [];
  const wanted = [
    "content_contract_get",
    "content_contract_upsert",
    "content_gate_run",
    "content_gate_run_list",
  ];
  const found = wanted.map((n) => {
    const t = tools.find((x) => x.name === n);
    return {
      name: n,
      present: Boolean(t),
      descLen: t?.description?.length ?? 0,
      descHead: t?.description?.slice(0, 80) ?? null,
    };
  });
  log(`tools/list — ${tools.length} tools no total`, found);
  results["tools/list"] = found.every((f) => f.present && f.descLen > 0)
    ? "PASS"
    : "FAIL";

  // --- passo 1: upsert cria ---
  const created = await callTool("content_contract_upsert", {
    slug,
    title: "Contrato E2E via MCP",
    outputLabel: "roteiro",
    status: "active",
    audience: {
      who: "segurado do INSS leigo",
      notWho: ["advogado"],
      situation: "pesquisando no YouTube",
    },
    ethicalLine: [
      {
        id: "sem-promessa",
        rule: "nunca prometer resultado",
        rationale: "prognóstico não é garantia",
      },
    ],
    allowedFacts: [
      {
        id: "bpc-idade",
        statement: "BPC ao idoso exige 65 anos",
        scope: "afirmavel",
        source: "Lei 8.742/93 art. 20",
      },
    ],
    forbiddenFacts: [
      {
        id: "garantia-de-ganho",
        claim: "afirmar que o benefício é garantido",
        forms: ["ganho garantido", "você vai receber com certeza"],
        neutralForm: "cada caso é analisado individualmente pelo INSS",
        reason: "promessa de resultado é vedada",
        status: "proibido",
      },
    ],
    outOfScope: [
      {
        id: "tributario",
        item: "direito tributário",
        owner: "outro squad",
        forms: ["imposto de renda"],
        question: "o roteiro fala de tributo?",
      },
    ],
    tone: { tone_words: ["direto"], anti_tone_words: ["incrível"] },
    deliveryLimits: [
      { channel: "whatsapp", maxBytes: 16000000, notes: "limite de vídeo" },
    ],
    sourcePrecedence: [{ rank: 1, source: "lei", note: "fonte primária" }],
    productionInvariants: [
      {
        id: "legenda",
        invariant: "sempre legendado",
        rationale: "assistido sem som",
      },
    ],
    summary: "cria contrato de verificação MCP",
    reason: "provar que a tool cria contrato ponta a ponta pelo servidor MCP",
  });
  log("1) content_contract_upsert (create)", created);
  const createdPayload = parsePayload(created);
  results["upsert:create"] =
    createdPayload?.created === true && createdPayload?.contract?.version === 1
      ? "PASS"
      : "FAIL";

  // --- passo 2: get lê de volta ---
  const gotEnv = await callTool("content_contract_get", { slug });
  const got = parsePayload(gotEnv);
  log("2) content_contract_get", got);
  const matches =
    got?.contract?.slug === slug &&
    got?.contract?.title === "Contrato E2E via MCP" &&
    got?.contract?.outputLabel === "roteiro" &&
    got?.contract?.audience?.who === "segurado do INSS leigo" &&
    got?.contract?.forbiddenFacts?.[0]?.id === "garantia-de-ganho" &&
    got?.contract?.forbiddenFacts?.[0]?.neutralForm ===
      "cada caso é analisado individualmente pelo INSS" &&
    got?.contract?.deliveryLimits?.[0]?.maxBytes === 16000000 &&
    Array.isArray(got?.versions) &&
    got.versions.length === 1 &&
    got.versions[0]?.summary === "cria contrato de verificação MCP";
  results["get:conteudo-bate"] = matches ? "PASS" : "FAIL";

  // --- passo 3: upsert emenda e bumpa versão ---
  const amended = await callTool("content_contract_upsert", {
    slug,
    allowedFacts: [
      {
        id: "bpc-idade",
        statement: "BPC ao idoso exige 65 anos",
        scope: "afirmavel",
        source: "Lei 8.742/93 art. 20",
      },
      {
        id: "bpc-renda",
        statement: "a renda per capita entra na análise",
        scope: "condicional",
        source: "Tema 27",
      },
    ],
    summary: "acrescenta fato permitido sobre renda",
    reason: "fonte primária (Tema 27) contradizia a omissão do contrato",
  });
  log("3) content_contract_upsert (amend/bump)", amended);
  const amendedPayload = parsePayload(amended);
  results["upsert:bump"] =
    amendedPayload?.created === false &&
    amendedPayload?.bumped === true &&
    amendedPayload?.contract?.version === 2
      ? "PASS"
      : "FAIL";

  // --- passo 4a: gate que REPROVA com blocking true ---
  const failing = await callTool("content_gate_run", {
    slug,
    gate: "forbidden-facts",
    material:
      "Olha só: esse é um ganho garantido, você vai receber com certeza no mês que vem.",
    materialRef: "roteiro-teste.md",
  });
  log("4a) content_gate_run — forbidden-facts (deve BLOQUEAR)", failing);
  const failPayload = parsePayload(failing);
  results["gate:bloqueante"] =
    failPayload?.blocking === true &&
    failPayload?.passed === false &&
    failPayload?.run?.status === "failed"
      ? "PASS"
      : "FAIL";

  // --- passo 4b: gate que PASSA ---
  const passing = await callTool("content_gate_run", {
    slug,
    gate: "forbidden-facts",
    material:
      "Cada caso é analisado individualmente pelo INSS; o que dá para fazer é reunir os documentos certos.",
    materialRef: "roteiro-corrigido.md",
  });
  log("4b) content_gate_run — forbidden-facts (deve PASSAR)", passing);
  const passPayload = parsePayload(passing);
  results["gate:passa"] =
    passPayload?.passed === true &&
    passPayload?.blocking === false &&
    passPayload?.run?.status === "passed"
      ? "PASS"
      : "FAIL";

  // --- passo 4c: delivery-limit medindo um arquivo real (caminho absoluto) ---
  const tmpFile = join(userDataCopy, "material-medido.txt");
  writeFileSync(tmpFile, "x".repeat(1234));
  const measured = await callTool("content_gate_run", {
    slug,
    gate: "delivery-limit",
    material: tmpFile,
    channel: "whatsapp",
  });
  log("4c) content_gate_run — delivery-limit (mede arquivo real)", measured);
  const measuredPayload = parsePayload(measured);
  results["gate:delivery-limit"] =
    measuredPayload?.passed === true &&
    /1234 B/.test(measuredPayload?.evidence ?? "")
      ? "PASS"
      : "FAIL";

  // --- passo 5: gate_run_list ---
  const listEnv = await callTool("content_gate_run_list", {
    contractId: createdPayload?.contract?.id,
  });
  const runs = parsePayload(listEnv);
  log("5) content_gate_run_list", runs);
  results["gate_run_list"] =
    Array.isArray(runs?.items) && runs.items.length === 3 ? "PASS" : "FAIL";

  // --- passo 6: upsert SEM changelog deve ser rejeitado pelo schema ---
  const noChangelog = await callTool("content_contract_upsert", {
    slug,
    status: "draft",
  });
  log(
    "6) content_contract_upsert SEM summary/reason (deve ser REJEITADO)",
    noChangelog,
  );
  results["upsert:sem-changelog-rejeitado"] =
    noChangelog?.isError === true ? "PASS" : "FAIL";

  log("RESUMO", results);
} catch (err) {
  console.error("\n!!!!! ERRO NO CENÁRIO !!!!!");
  console.error(err);
  log("RESUMO PARCIAL", results);
} finally {
  console.log(`\nlog: ${logFile}`);
  stop();
  await app.close();
}
