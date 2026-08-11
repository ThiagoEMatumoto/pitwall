// PONTO ÚNICO DE TROCA DO TRANSPORTE DA IDENTIDADE DA SESSÃO-MÃE.
//
// O servidor MCP é compartilhado por TODAS as sessões que o app spawna, então uma
// tool não tem como saber sozinha quem a chamou — o app carimba a identidade no
// spawn (determinístico: nada depende do modelo preencher um campo).
//
// Hoje o carimbo viaja na QUERY STRING (`?s=<sessions.id>`) do arquivo de
// mcp-config por sessão: server.ts já faz `new URL(req.url)` e barra só por
// `pathname !== '/mcp'`, então a query é tolerada sem encostar no caminho de auth
// (timingSafeEqual do bearer).
//
// Se a query string não sobreviver da CLI até o servidor, o fallback é o header
// `X-CM-Session-Id`: troque APENAS as duas funções deste arquivo (build + read) —
// nenhum outro módulo conhece o transporte. O lado servidor JÁ lê o header, então
// o fallback é uma linha em buildSessionEndpoint.
//
// Módulo PURO (sem electron/fs).

export const MCP_SESSION_QUERY_PARAM = 's'
export const MCP_SESSION_HEADER = 'x-cm-session-id'

// sessions.id é sempre randomUUID(); validar aqui impede que lixo do request
// vire um mother_session_id inventado no banco.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface McpEndpoint {
  url: string
  headers: Record<string, string>
}

// Lado CLIENTE: url + headers que vão pro arquivo de mcp-config. sessionId null
// (config global/legada) devolve o endpoint idêntico ao de antes.
export function buildSessionEndpoint(
  base: { url: string; token: string },
  sessionId: string | null,
): McpEndpoint {
  const headers: Record<string, string> = { Authorization: `Bearer ${base.token}` }
  if (!sessionId) return { url: base.url, headers }
  // FALLBACK: trocar as 3 linhas abaixo por
  //   headers[MCP_SESSION_HEADER] = sessionId; return { url: base.url, headers }
  const url = new URL(base.url)
  url.searchParams.set(MCP_SESSION_QUERY_PARAM, sessionId)
  return { url: url.toString(), headers }
}

// Lado SERVIDOR: extrai a identidade do request. Lê query E header — assim o
// fallback já funciona deste lado sem tocar em server.ts. Ausente ou malformado
// → null (o dedup cai no escopo legado, por repo).
export function readMotherSessionId(req: {
  url: URL
  headers?: Record<string, string | string[] | undefined>
}): string | null {
  const fromQuery = req.url.searchParams.get(MCP_SESSION_QUERY_PARAM)
  const rawHeader = req.headers?.[MCP_SESSION_HEADER]
  const fromHeader = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader
  const raw = fromQuery ?? fromHeader ?? null
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) return null
  return raw
}
