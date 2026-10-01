// Provider da CLI `codex` (OpenAI), EXPERIMENTAL. Flags conferidas no
// `codex --help` 0.145: -m, -s, -a, -c key=value (TOML), --no-alt-screen e o
// prompt inicial posicional. Não há id de sessão escolhido no spawn nem índice
// de status no disco: o status vem da própria PTY (pty-status.ts) e a sessão
// não é retomável nem adotável (sem cc_session_id, o mesmo gate de adopt.ts).
import type { AgentProvider, LaunchOpts } from './types'
import { shquote } from './claude'
import { codexPolicyFor } from '../spawn-flags'
import { PROVIDER_LABELS, PROVIDER_SUPPORTS } from '../../../../shared/agent-providers'

const CODEX_COMMAND_KEY = 'codex_command'
const MCP_SERVER = 'pitwall'

// Nome da variável que carrega o bearer do MCP do Pitwall na PTY do Codex. O
// valor (a credencial) nunca entra na linha de comando: `ps` mostraria.
export const CODEX_MCP_TOKEN_ENV = 'PITWALL_MCP_TOKEN'

// `-c` parseia o valor como TOML. JSON.stringify gera uma string básica TOML
// válida (aspas, \n, \" e \\ escapados do mesmo jeito).
function configFlag(key: string, value: string): string {
  return ` -c ${shquote(`${key}=${JSON.stringify(value)}`)}`
}

// Ordem: modo/sandbox → MCP → modelo → instruções → prompt. O posicional TEM que
// ser o último token. Campos só do claude (resume, -n, effort, advisor,
// denylist, --settings, arquivo de system-prompt) não têm equivalente e saem fora.
function buildCodexInnerCmd(opts: LaunchOpts): string {
  const { sandbox, approval } = codexPolicyFor(opts.permissionMode)
  let innerCmd = `${opts.command} --no-alt-screen -s ${shquote(sandbox)} -a ${shquote(approval)}${opts.mcpConfigArg}`
  if (opts.model) innerCmd += ` -m ${shquote(opts.model)}`
  if (opts.systemPromptText?.trim()) {
    innerCmd += configFlag('developer_instructions', opts.systemPromptText.trim())
  }
  if (opts.initialPrompt?.trim()) innerCmd += ` ${shquote(opts.initialPrompt.trim())}`
  return innerCmd
}

export const codexProvider: AgentProvider & { discoverNativeId(): string | null } = {
  id: 'codex',
  label: PROVIDER_LABELS.codex,
  resolveCommand: (readPref) => readPref(CODEX_COMMAND_KEY) || 'codex',
  buildLaunch: buildCodexInnerCmd,
  mcpVia: 'url',
  mcpInject: ({ url }) =>
    url
      ? configFlag(`mcp_servers.${MCP_SERVER}.url`, url) +
        configFlag(`mcp_servers.${MCP_SERVER}.bearer_token_env_var`, CODEX_MCP_TOKEN_ENV)
      : '',
  mcpEnv: ({ token }) => ({ [CODEX_MCP_TOKEN_ENV]: token }),
  supports: PROVIDER_SUPPORTS.codex,
  // Stub: o Codex grava sessões em ~/.codex/sessions/AAAA/MM/DD/rollout-*.jsonl,
  // mas sem login não há rollout real para confirmar o formato. Enquanto isto
  // devolve null, a sessão fica sem cc_session_id → resume/adoção desligados.
  discoverNativeId: () => null,
}
