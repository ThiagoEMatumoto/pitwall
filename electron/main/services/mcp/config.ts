// Configuração do MCP server embutido: porta (app_prefs) e bearer token
// (gerado uma vez, persistido em <userData>/mcp.json com mode 0600).
import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../db'
import { buildSessionEndpoint } from './session-identity'

export const DEFAULT_MCP_PORT = 41956
export const MCP_PORT_PREF_KEY = 'mcp_port'
export const MCP_PORT_ENV_VAR = 'CM_MCP_PORT'

// Env override (CM_MCP_PORT): aceita 0 = porta efêmera do SO, útil pra rodar
// uma segunda instância (E2E/dev) sem colidir com o app instalado na 41956.
export function parseMcpPortEnv(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const value = Number(raw.trim())
  if (Number.isInteger(value) && value >= 0 && value < 65536) return value
  return null
}

// Precedência: env CM_MCP_PORT > pref mcp_port > default. Pura pra testar sem
// DB/electron. Pref não aceita 0 (porta efêmera só faz sentido como override).
export function resolveMcpPort(envRaw: string | undefined, prefPort: number | null): number {
  const fromEnv = parseMcpPortEnv(envRaw)
  if (fromEnv !== null) return fromEnv
  if (
    prefPort !== null &&
    Number.isInteger(prefPort) &&
    prefPort > 0 &&
    prefPort < 65536
  ) {
    return prefPort
  }
  return DEFAULT_MCP_PORT
}

function getPrefPort(): number | null {
  const row = getDb()
    .prepare('SELECT value FROM app_prefs WHERE key = ?')
    .get(MCP_PORT_PREF_KEY) as { value: string } | undefined
  if (!row) return null
  try {
    const value: unknown = JSON.parse(row.value)
    if (typeof value === 'number') return value
  } catch {
    // valor corrompido → null (resolve pro default)
  }
  return null
}

export function getMcpPort(): number {
  return resolveMcpPort(process.env[MCP_PORT_ENV_VAR], getPrefPort())
}

// Arquivo de descoberta consumido por sessões externas (claude mcp add) e pela
// injeção no spawn (B4). O token é a credencial — daí o mode 0600.
export interface McpRuntimeInfo {
  url: string
  token: string
  pid: number
}

export function mcpConfigPath(): string {
  return join(app.getPath('userData'), 'mcp.json')
}

// Token gerado uma vez e reutilizado entre boots: se o mcp.json anterior tem um
// token válido, mantém (configs externas já apontam pra ele); senão gera novo.
export function loadOrCreateToken(path: string = mcpConfigPath()): string {
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<McpRuntimeInfo>
      if (typeof parsed.token === 'string' && parsed.token.length >= 32) return parsed.token
    } catch {
      // arquivo corrompido → regenera
    }
  }
  return randomBytes(32).toString('hex')
}

export function writeMcpRuntimeInfo(info: McpRuntimeInfo, path: string = mcpConfigPath()): void {
  writeFileSync(path, JSON.stringify(info, null, 2) + '\n', { mode: 0o600 })
  // O mode do writeFileSync só vale na criação; se o arquivo já existia com
  // outra permissão, força 0600.
  chmodSync(path, 0o600)
}

// Config no formato consumido pelo `claude --mcp-config`: mesmo shape do
// .mcp.json de projetos (mcpServers → nome → {type, url, headers}). Regenerado
// a cada boot junto com o mcp.json — URL/token sempre atuais. Contém o token,
// daí o mesmo mode 0600.
export function mcpClientConfigPath(): string {
  return join(app.getPath('userData'), 'mcp-client-config.json')
}

// sessionId opcional: quando presente, o endpoint carrega a identidade da
// sessão-mãe (ver session-identity.ts). O NOME do server ('claude-manager') e o
// shape do arquivo NÃO mudam — allowlists de usuário e transcripts referenciam
// `mcp__claude-manager__*`.
export function writeMcpClientConfig(
  info: McpRuntimeInfo,
  path: string = mcpClientConfigPath(),
  sessionId: string | null = null,
): void {
  const endpoint = buildSessionEndpoint(info, sessionId)
  const config = {
    mcpServers: {
      'claude-manager': {
        type: 'http',
        url: endpoint.url,
        headers: endpoint.headers,
      },
    },
  }
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
}

// --- Config POR SESSÃO (carimbo de identidade da mãe) ---
// Um arquivo por sessions.id em <userData>/mcp-sessions/<id>.json. O arquivo
// GLOBAL continua existindo e intocado (sessões vivas com a config antiga,
// `claude mcp add`) — quem não tem carimbo cai no dedup legado, por repo.

export function sessionMcpConfigDir(): string {
  return join(app.getPath('userData'), 'mcp-sessions')
}

export function sessionMcpConfigPath(
  sessionId: string,
  dir: string = sessionMcpConfigDir(),
): string {
  return join(dir, `${sessionId}.json`)
}

// Escreve (e devolve) o path da config da sessão. Contém o token → arquivo 0600,
// diretório 0700.
export function writeSessionMcpClientConfig(
  info: McpRuntimeInfo,
  sessionId: string,
  dir: string = sessionMcpConfigDir(),
): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = sessionMcpConfigPath(sessionId, dir)
  writeMcpClientConfig(info, path, sessionId)
  return path
}

// Best-effort: chamado no exit da PTY (o e.sessionId é o próprio nome do
// arquivo). Arquivo já removido / diretório ausente nunca pode derrubar o exit.
export function removeSessionMcpConfig(
  sessionId: string,
  dir: string = sessionMcpConfigDir(),
): void {
  try {
    rmSync(sessionMcpConfigPath(sessionId, dir), { force: true })
  } catch {
    // ignora
  }
}

// Varredura de boot: nenhuma PTY sobrevive ao quit, então todo arquivo que
// sobrou no diretório é órfão. Devolve quantos removeu (log/teste).
export function sweepSessionMcpConfigs(dir: string = sessionMcpConfigDir()): number {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0 // diretório ainda não existe → nada a varrer
  }
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      rmSync(join(dir, name), { force: true })
      removed++
    } catch {
      // segue varrendo os demais
    }
  }
  return removed
}

// --- Cleanup de configs stale (caminho do EADDRINUSE) ---
// Cenário: outra instância (app instalado) segura a porta e ESTE processo roda
// sem MCP. Se o userData corrente tem mcp.json/mcp-client-config.json herdados
// (ex: cópia de userData pra E2E), sessões conectariam silenciosamente no
// servidor de OUTRO processo. Decisão: se o pid do mcp.json existente é de
// OUTRO processo VIVO, o arquivo é legítimo (instância nossa rodando neste
// mesmo userData) → manter; em qualquer outro caso (sem pid, pid morto, ou
// pid == nosso, i.e. sobra deste próprio boot) → deletar ambos os arquivos.
export type StaleConfigDecision = 'keep' | 'delete'

export function decideStaleConfigCleanup(
  existingPid: number | null,
  selfPid: number,
  isPidAlive: (pid: number) => boolean,
): StaleConfigDecision {
  if (existingPid !== null && existingPid !== selfPid && isPidAlive(existingPid)) return 'keep'
  return 'delete'
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = processo existe mas não é nosso → vivo.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function cleanupStaleMcpConfigs(
  configFilePath: string = mcpConfigPath(),
  clientConfigFilePath: string = mcpClientConfigPath(),
  sessionConfigDir: string = sessionMcpConfigDir(),
): StaleConfigDecision {
  let existingPid: number | null = null
  if (existsSync(configFilePath)) {
    try {
      const parsed = JSON.parse(readFileSync(configFilePath, 'utf8')) as Partial<McpRuntimeInfo>
      if (typeof parsed.pid === 'number') existingPid = parsed.pid
    } catch {
      // corrompido → sem pid → deleta
    }
  }
  const decision = decideStaleConfigCleanup(existingPid, process.pid, pidIsAlive)
  if (decision === 'delete') {
    rmSync(configFilePath, { force: true })
    rmSync(clientConfigFilePath, { force: true })
    // As configs POR SESSÃO apontam pro mesmo server stale — vão junto.
    rmSync(sessionConfigDir, { recursive: true, force: true })
  }
  return decision
}
