// IPC do MCP: status read-only do server embutido (Settings → Geral) +
// gestão dos MCP servers do CLI claude (listar via arquivos de config;
// add/remove via shell-out validado — mesmo padrão de claude-plugins.ts).
// O token do server embutido só sai daqui dentro do addCommand (copiável
// pelo usuário) — a UI nunca persiste nada; a fonte de verdade é o runtime.
import { ipcMain } from 'electron'
import { getMcpRuntime } from '../services/mcp/server'
import { runClaude } from '../services/claude-cli'
import {
  buildMcpAddArgs,
  buildMcpRemoveArgs,
  listMcpServers,
  resolveRepoPath,
  validateMcpAdd,
  validateMcpRemove,
} from '../services/mcp-servers'
import type { McpActionResult, McpServerEntry, McpStatus } from '../../../shared/types/ipc'

function toResult(result: { stdout: string; stderr: string; code: number }): McpActionResult {
  const message = (result.stdout.trim() || result.stderr.trim() || '').trim()
  return {
    ok: result.code === 0,
    message: message || (result.code === 0 ? 'OK' : `Falha (code ${result.code})`),
  }
}

export function registerMcpIpc(): void {
  ipcMain.handle('mcp:status', (): McpStatus => {
    const runtime = getMcpRuntime()
    if (!runtime) {
      return { running: false, port: null, url: null, addCommand: null }
    }
    return {
      running: true,
      port: runtime.port,
      url: runtime.url,
      addCommand: `claude mcp add --transport http pitwall ${runtime.url} --header "Authorization: Bearer ${runtime.token}"`,
    }
  })

  ipcMain.handle('cc:mcp:list', async (): Promise<McpServerEntry[]> => {
    return listMcpServers()
  })

  ipcMain.handle('cc:mcp:add', async (_e, payload: unknown): Promise<McpActionResult> => {
    try {
      const input = validateMcpAdd(payload)
      // project scope: cwd resolvido pelo DB — nunca aceita path do renderer.
      const cwd = input.scope === 'project' ? resolveRepoPath(input.repoId as string) : undefined
      return toResult(await runClaude(buildMcpAddArgs(input), { timeoutMs: 30_000, cwd }))
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cc:mcp:remove', async (_e, payload: unknown): Promise<McpActionResult> => {
    try {
      const input = validateMcpRemove(payload)
      const cwd = input.scope === 'project' ? resolveRepoPath(input.repoId as string) : undefined
      return toResult(await runClaude(buildMcpRemoveArgs(input), { timeoutMs: 30_000, cwd }))
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
}
