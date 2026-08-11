// MCP server embutido no main process: Streamable HTTP stateless em node:http,
// bound 127.0.0.1, autenticado por bearer token (mcp.json) + validação de Host.
// Stateless = um McpServer/transport novo por request (sem sessão), o que deixa
// o endpoint utilizável por N clientes simultâneos sem gerência de sessão.
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { app } from 'electron'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import {
  cleanupStaleMcpConfigs,
  getMcpPort,
  loadOrCreateToken,
  mcpClientConfigPath,
  mcpConfigPath,
  sessionMcpConfigDir,
  sweepSessionMcpConfigs,
  writeMcpClientConfig,
  writeMcpRuntimeInfo,
} from './config'
import { readMotherSessionId } from './session-identity'
import { registerTools, type McpNotify } from './tools'
import { SERVER_INSTRUCTIONS } from './instructions'
import {
  broadcast,
  broadcastAffectedObjectives,
  broadcastAffectedObjectivesForFeatureLinks,
} from '../notify'

const defaultNotify: McpNotify = {
  broadcast,
  affectedObjectives: (links) => broadcastAffectedObjectives(links),
  affectedObjectivesForFeatureLinks: (links) => broadcastAffectedObjectivesForFeatureLinks(links),
}

// Só aceita requests cujo Host é local — barra DNS rebinding (um site malicioso
// não consegue forjar o header Host de um fetch cross-origin pra cá).
function hostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false
  const host = hostHeader.replace(/:\d+$/, '').toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
}

function tokenMatches(authorization: string | undefined, token: string): boolean {
  if (!authorization) return false
  const expected = `Bearer ${token}`
  const got = Buffer.from(authorization)
  const want = Buffer.from(expected)
  return got.length === want.length && timingSafeEqual(got, want)
}

function deny(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: message }))
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return undefined
  return JSON.parse(raw)
}

export interface StartMcpOptions {
  // Overrides pra teste (porta efêmera, token fixo, notify mock, path do mcp.json).
  port?: number
  token?: string
  notify?: McpNotify
  configFilePath?: string
  clientConfigFilePath?: string
  sessionConfigDir?: string
}

export interface McpServerHandle {
  port: number
  url: string
  token: string
  close(): Promise<void>
}

let running: McpServerHandle | null = null

// Consultado pelo spawn de sessões (B4) e pelo mcp:status: null = server não
// subiu (EADDRINUSE etc.) → ninguém injeta --mcp-config nem anuncia URL.
export function getMcpRuntime(): McpServerHandle | null {
  return running
}

export async function startMcpServer(opts: StartMcpOptions = {}): Promise<McpServerHandle | null> {
  const configFilePath = opts.configFilePath ?? mcpConfigPath()
  const clientConfigFilePath = opts.clientConfigFilePath ?? mcpClientConfigPath()
  const sessionConfigDir = opts.sessionConfigDir ?? sessionMcpConfigDir()
  const token = opts.token ?? loadOrCreateToken(configFilePath)
  const port = opts.port ?? getMcpPort()
  const notify = opts.notify ?? defaultNotify

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!hostAllowed(req.headers.host)) return deny(res, 403, 'forbidden host')
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/mcp') return deny(res, 404, 'not found')
      if (!tokenMatches(req.headers.authorization, token)) return deny(res, 401, 'unauthorized')

      // Identidade da sessão-mãe carimbada pelo app no spawn (mcp-config por
      // sessão). Como o McpServer já é criado POR REQUEST, o contexto é
      // naturalmente por request — sem AsyncLocalStorage. null = config global
      // legada → o dedup de handoff cai no escopo por repo.
      const motherSessionId = readMotherSessionId({ url, headers: req.headers })

      // Stateless: instâncias novas por request, descartadas no fim da resposta.
      // instructions: injetadas pelo client no contexto da sessão (auto-tracking).
      const mcp = new McpServer(
        { name: 'claude-manager', version: app.getVersion() },
        { instructions: SERVER_INSTRUCTIONS },
      )
      registerTools(mcp, notify, { motherSessionId })
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        void transport.close()
        void mcp.close()
      })
      await mcp.connect(transport)
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined
      await transport.handleRequest(req, res, body)
    } catch (err) {
      console.error('[mcp] request error:', err)
      if (!res.headersSent) deny(res, 500, 'internal error')
      else res.end()
    }
  }

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      void handle(req, res)
    })
    server.once('error', (err) => {
      // EADDRINUSE (outra instância/processo na porta) ou afins: o app segue
      // funcionando sem MCP — nunca crashar o boot por causa disso.
      console.error(`[mcp] failed to listen on 127.0.0.1:${port} — continuing without MCP:`, err)
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        // Sem server próprio, configs no NOSSO userData apontariam pra um
        // server stale (ex: userData copiado pra E2E) → remove, a menos que
        // pertençam a outra instância viva (ver decideStaleConfigCleanup).
        try {
          const decision = cleanupStaleMcpConfigs(
            configFilePath,
            clientConfigFilePath,
            sessionConfigDir,
          )
          if (decision === 'keep') {
            console.warn('[mcp] mcp.json belongs to another live instance — leaving config files')
          }
        } catch (cleanupErr) {
          console.error('[mcp] failed to clean stale mcp config files:', cleanupErr)
        }
      }
      resolve(null)
    })
    server.listen(port, '127.0.0.1', () => {
      const actualPort = (server.address() as AddressInfo).port
      const url = `http://127.0.0.1:${actualPort}/mcp`
      try {
        writeMcpRuntimeInfo({ url, token, pid: process.pid }, configFilePath)
        writeMcpClientConfig({ url, token, pid: process.pid }, clientConfigFilePath)
        // Nenhuma PTY sobrevive ao quit: configs por sessão que restaram no
        // diretório são órfãs (e apontariam pra uma porta/token antigos).
        sweepSessionMcpConfigs(sessionConfigDir)
      } catch (err) {
        console.error('[mcp] failed to write mcp config files (server stays up):', err)
      }
      const handleObj: McpServerHandle = {
        port: actualPort,
        url,
        token,
        close: () => closeHttpServer(server),
      }
      running = handleObj
      console.log(`[mcp] listening on ${url}`)
      resolve(handleObj)
    })
  })
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
    // Derruba conexões keep-alive penduradas pra não segurar o quit.
    server.closeAllConnections()
  })
}

export async function stopMcpServer(): Promise<void> {
  if (!running) return
  const current = running
  running = null
  await current.close()
}
