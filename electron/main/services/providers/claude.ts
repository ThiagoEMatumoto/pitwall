// Provider da CLI `claude`. As whitelists e o denylist que validam o que chega a
// buildLaunch vivem em ../spawn-flags.ts (também importado pelo renderer, por isso
// continua um módulo à parte) e são específicos deste provider.
import type { AgentProvider, LaunchOpts } from './types'
import { PROVIDER_LABELS, PROVIDER_SUPPORTS } from '../../../../shared/agent-providers'

const CLAUDE_COMMAND_KEY = 'claude_command'

// O name é input do usuário e entra na linha de `zsh -c '<innerCmd>'`.
// Aspas simples POSIX impedem qualquer interpretação pelo shell; o único caractere
// perigoso dentro de '...' é a própria aspa simples, fechada com '\'' e reaberta.
export function shquote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

// Monta a string do innerCmd. PURA: recebe os pedaços já resolvidos. Mantém a
// ordem das flags do handler original.
//
// `initialPrompt` (opcional): prompt posicional entregue no COMANDO de spawn, não
// injetado no PTY. `claude "<prompt>"` em modo interativo faz auto-submit do 1º
// turno — é o caminho confiável pra background (o kickoff colado no PTY é
// descartado quando ninguém dá resize no TUI). Como posicional, TEM que ser o
// último token, depois de todas as flags.
function buildClaudeInnerCmd(opts: LaunchOpts): string {
  const idFlag = opts.resume ? '--resume' : '--session-id'
  let innerCmd = `${opts.command} ${idFlag} ${opts.sessionId} -n ${shquote(opts.name)}${opts.mcpConfigArg}`
  if (opts.model) {
    innerCmd += ` --model ${shquote(opts.model)}`
  }
  if (opts.effort) {
    innerCmd += ` --effort ${shquote(opts.effort)}`
  }
  if (opts.advisorModel) {
    innerCmd += ` --advisor ${shquote(opts.advisorModel)}`
  }
  if (opts.permissionMode) {
    innerCmd += ` --permission-mode ${shquote(opts.permissionMode)}`
  }
  if (opts.disallowedTools && opts.disallowedTools.length > 0) {
    innerCmd += ` --disallowedTools ${opts.disallowedTools.map(shquote).join(' ')}`
  }
  if (opts.settingsJson) {
    innerCmd += ` --settings ${shquote(opts.settingsJson)}`
  }
  if (opts.systemPromptFilePath) {
    innerCmd += ` --append-system-prompt-file ${shquote(opts.systemPromptFilePath)}`
  }
  if (opts.initialPrompt?.trim()) {
    innerCmd += ` ${shquote(opts.initialPrompt.trim())}`
  }
  return innerCmd
}

export const claudeProvider: AgentProvider = {
  id: 'claude',
  label: PROVIDER_LABELS.claude,
  resolveCommand: (readPref) => readPref(CLAUDE_COMMAND_KEY) || 'claude',
  buildLaunch: buildClaudeInnerCmd,
  mcpVia: 'config-file',
  // Sem --strict-mcp-config: os servers de user/projeto do claude continuam valendo.
  mcpInject: ({ configPath }) => ` --mcp-config ${shquote(configPath)}`,
  supports: PROVIDER_SUPPORTS.claude,
}
