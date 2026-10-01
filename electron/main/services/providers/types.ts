import type { AgentProviderId } from '../../../../shared/types/ipc'
import type { ProviderSupports } from '../../../../shared/agent-providers'

export type { AgentProviderId }

// Lê um valor de app_prefs (já sem espaços nas bordas ou undefined). Injetado
// pelo chamador para o provider continuar PURO — cada um conhece a própria chave.
export type ReadPref = (key: string) => string | undefined

// Pedaços do launch já resolvidos pelo chamador: ids validados, model/effort/
// advisor/permission passados pelas whitelists, mcpConfigArg vindo de mcpInject.
export interface LaunchOpts {
  command: string
  sessionId: string
  // true = sessionId é de uma sessão EXISTENTE (retomada), não um id novo.
  resume?: boolean
  name: string
  mcpConfigArg: string
  model: string | null
  effort?: string | null
  advisorModel?: string | null
  systemPromptFilePath: string | null
  permissionMode?: string | null
  disallowedTools?: string[] | null
  settingsJson?: string | null
  initialPrompt?: string | null
  // Instruções de sistema como TEXTO, para provider sem flag de arquivo (Codex:
  // developer_instructions). O claude usa systemPromptFilePath e ignora isto.
  systemPromptText?: string | null
}

export interface AgentProvider {
  id: AgentProviderId
  label: string
  resolveCommand(readPref: ReadPref): string
  // String que o login shell executa (`<shell> -l -i -c 'exec <isto>'`).
  buildLaunch(opts: LaunchOpts): string
  // Como a CLI chega ao MCP server do Pitwall: 'config-file' lê o arquivo de
  // mcp-config por sessão (configPath); 'url' recebe o endpoint direto e o
  // bearer por env (mcpEnv).
  mcpVia: 'config-file' | 'url'
  // Argumento (com espaço inicial) que conecta a CLI ao MCP server do Pitwall.
  mcpInject(opts: { configPath: string; url?: string }): string
  // Env extra da PTY para o MCP (ex.: o bearer, que não pode ir na linha de comando).
  mcpEnv?(opts: { token: string }): Record<string, string>
  supports: ProviderSupports
}
