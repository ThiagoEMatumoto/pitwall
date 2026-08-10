// Whitelists e resolução das flags de spawn do claude — módulo PURO (sem electron,
// sem I/O). Fonte ÚNICA compartilhada entre o spawn interativo (ipc/sessions, via
// PTY) e o job-runner headless (`claude -p`). Extrair aqui garante que o denylist
// destrutivo (guard-rail de modo autônomo) NÃO drife entre os dois caminhos: um
// job autônomo rodando sem supervisão é blast radius pior que a sessão interativa.

import { SPAWNABLE_MODEL_ALIASES } from '../../../shared/models'

// Whitelist do --model: o valor vem do renderer/preset, mas o main re-valida —
// nada fora desta lista chega à linha de comando. Deriva do registro canônico
// (shared/models.ts), que só contém aliases literais ('opusplan' é o alias
// híbrido nativo da CLI: Opus no plan mode, Sonnet na execução).
export const SPAWN_MODEL_WHITELIST = new Set<string>(SPAWNABLE_MODEL_ALIASES)

// Settings entregues via `--settings <json-inline>` a CADA sessão-filha de
// handoff — NUNCA global. `crossSessionInbound: accept` deixa a filha RECEBER
// SendMessage do orquestrador; sem isso a mensagem fica `held` silenciosamente e
// o canal peer parece funcionar sem funcionar. Global afetaria todas as sessões
// do usuário, inclusive as que ele não quer expostas.
export const HANDOFF_CHILD_SETTINGS_JSON = '{"crossSessionInbound":"accept"}'

// Modo do handoff → --permission-mode da filha. 'interactive' fica sem flag
// (legado: o claude pergunta cada ação). Espelha permissionModeFor do renderer
// (src/store/handoffsStore.ts) — o main é quem decide quando o spawn parte da MCP.
export function permissionModeForHandoffMode(mode: string | null | undefined): string | null {
  switch (mode) {
    case 'plan':
      return 'plan'
    case 'auto-edits':
      return 'acceptEdits'
    default:
      return null
  }
}

// Whitelist do --effort: espelha a defesa-em-profundidade do --model.
export const SPAWN_EFFORT_WHITELIST = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

// Whitelist do --advisor: feature experimental (só Anthropic API direta). Se o CLI
// rejeitar em runtime, a sessão/job falha visível — mesmo tratamento de outras flags.
export const SPAWN_ADVISOR_WHITELIST = new Set(['opus', 'sonnet', 'fable'])

// Whitelist do --permission-mode: TODOS os choices da CLI claude. O main é a
// autoridade — valor fora desta lista vira null (= sem flag = default do claude).
export const SPAWN_PERMISSION_MODES = [
  'default',
  'plan',
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'dontAsk',
] as const
const SPAWN_PERMISSION_MODE_WHITELIST = new Set<string>(SPAWN_PERMISSION_MODES)

// Modos autônomos (editam/agem sem confirmar cada ação) que recebem o denylist
// destrutivo como guard-rail. plan é read-only e default pergunta tudo.
const AUTONOMOUS_PERMISSION_MODES = new Set<string>(['acceptEdits', 'auto', 'bypassPermissions'])

// Modos observe-only (read-only / pergunta-tudo) — os ÚNICOS permitidos para jobs
// agendados no MVP. Um job roda sem supervisão, então os modos autônomos ficam
// gated (bloqueados na UI e no MCP) até existirem os guards de segurança. É um
// ALLOWLIST explícito (fail-closed): NÃO derivar como complemento do autônomo —
// 'dontAsk' não está em AUTONOMOUS_PERMISSION_MODES e escaparia o gate.
export const OBSERVE_ONLY_PERMISSION_MODES = ['default', 'plan'] as const

// Denylist destrutivo canônico (defense-in-depth) aplicado SEMPRE que a sessão/job
// sobe em modo autônomo. Bloqueia as ops irreversíveis das regras do usuário.
export const DESTRUCTIVE_DENYLIST = [
  'Bash(rm:*)',
  'Bash(git push:*)',
  'Bash(git reset --hard:*)',
  'Bash(git push --force:*)',
  'Bash(git push -f:*)',
  'Bash(git clean:*)',
]

// Browser tools do Playwright global (plugin do usuário), liberadas SÓ para jobs
// web-audit. Prefixo confirmado no spike Fase 0: mcp__plugin_playwright_playwright__.
// O `claude -p` headless herda o Playwright global SEM --mcp-config (o MCP do
// claude-manager NÃO é herdado → self-elevation fechada por construção). As 10 tools
// são as usadas pela skill browser-validate (nav/snapshot/screenshot/console/network/
// evaluate/type/click/fill_form/wait_for).
const PLAYWRIGHT_PREFIX = 'mcp__plugin_playwright_playwright__'
export const WEB_AUDIT_BROWSER_TOOLS = [
  'browser_navigate',
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_console_messages',
  'browser_network_requests',
  'browser_evaluate',
  'browser_type',
  'browser_click',
  'browser_fill_form',
  'browser_wait_for',
].map((t) => PLAYWRIGHT_PREFIX + t)

// Sob `claude -p --permission-mode default` headless, Read/Grep/Glob são
// auto-aprovados mas Bash NÃO é — sem estar no --allowedTools, o modelo trava
// pedindo aprovação a cada comando (não há humano pra confirmar → o job falha).
// web-audit precisa ler as credenciais de login da feature de Env via `printenv`;
// liberamos SÓ `Bash(printenv:*)` (ler env), o mínimo pra autenticar sem expor o
// segredo na command line. Bash geral continua fora — o read-only lockdown
// (JOB_READONLY_DISALLOW + DESTRUCTIVE_DENYLIST) permanece intacto.
export const WEB_AUDIT_ENV_TOOL = 'Bash(printenv:*)'

// Allowlist ADITIVO por kind (o spike provou que --allowedTools é aditivo: Read/
// Grep/Glob sobrevivem fora dele — Bash é a exceção headless, ver acima). web-audit
// libera as browser tools + printenv; critique (e qualquer kind desconhecido →
// fail-closed) recebe [] = sem allowlist, o comportamento atual. A decisão vive no
// MAIN (o runner monta --allowedTools só a partir daqui), nunca no renderer. Convive
// com o --disallowedTools (lockdown): nem as browser tools nem printenv estão no
// denylist, então não há conflito de precedência.
export function resolveJobAllowedTools(kind: string): string[] {
  return kind === 'web-audit' ? [...WEB_AUDIT_BROWSER_TOOLS, WEB_AUDIT_ENV_TOOL] : []
}

// Read-only lockdown EXCLUSIVO de jobs headless: bloqueia TODA escrita de arquivo.
// Um job observe-only roda em `default` (pergunta tudo) mas sem humano pra confirmar
// — então nenhuma tool de escrita pode existir. Ele LÊ/analisa (Read/Grep/Glob/Bash
// não-destrutivo) e produz a crítica no relatório, sem tocar em nada. NÃO se aplica
// ao spawn interativo (sessions), onde o humano supervisiona cada edição.
export const JOB_READONLY_DISALLOW = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']

// Valida o modo de permissão contra a whitelist. Retorna o modo se válido, senão
// null (= sem flag = default do claude).
export function resolvePermissionMode(value: string | null | undefined): string | null {
  return value && SPAWN_PERMISSION_MODE_WHITELIST.has(value) ? value : null
}

// Predicado do allowlist observe-only. Usado pelo job-runner como guard fail-closed
// (defense-in-depth): um job cuja row resolva para modo autônomo é finalizado como
// failed SEM spawnar — as fronteiras MCP/UI já barram a criação, este é o piso.
const OBSERVE_ONLY_SET = new Set<string>(OBSERVE_ONLY_PERMISSION_MODES)
export function isObserveOnlyMode(mode: string): boolean {
  return OBSERVE_ONLY_SET.has(mode)
}

// Denylist de um job HEADLESS. Diferente do spawn interativo, o job SEMPRE recebe o
// denylist destrutivo E o read-only lockdown — mesmo em observe-only (default/plan):
// roda sem supervisão, então nenhum modo pode ficar sem o guard-rail e nenhuma tool
// de escrita pode existir. Mescla o denylist do renderer/job (que não consegue
// enfraquecê-lo). Fontes = DESTRUCTIVE_DENYLIST + JOB_READONLY_DISALLOW.
export function resolveJobDisallowedTools(
  rendererDeny: readonly unknown[] | null | undefined,
): string[] {
  const deny = (rendererDeny ?? []).filter(
    (t): t is string => typeof t === 'string' && t.length > 0,
  )
  return Array.from(new Set([...deny, ...DESTRUCTIVE_DENYLIST, ...JOB_READONLY_DISALLOW]))
}

// Monta o denylist final do spawn. Mescla o denylist destrutivo canônico quando o
// modo é autônomo (o renderer/job não pode enfraquecê-lo); senão devolve só o
// denylist do renderer (ou null se vazio). Filtra specs não-string/vazios.
export function resolveDisallowedTools(
  permissionMode: string | null,
  rendererDeny: readonly unknown[] | null | undefined,
): string[] | null {
  const deny = (rendererDeny ?? []).filter(
    (t): t is string => typeof t === 'string' && t.length > 0,
  )
  if (permissionMode && AUTONOMOUS_PERMISSION_MODES.has(permissionMode)) {
    return Array.from(new Set([...deny, ...DESTRUCTIVE_DENYLIST]))
  }
  return deny.length > 0 ? deny : null
}

// Valida o --model contra a whitelist. Retorna o valor ou null (= sem flag).
export function resolveModel(value: string | null | undefined): string | null {
  return value && SPAWN_MODEL_WHITELIST.has(value) ? value : null
}

// Valida o --effort contra a whitelist. Retorna o valor ou null (= sem flag).
export function resolveEffort(value: string | null | undefined): string | null {
  return value && SPAWN_EFFORT_WHITELIST.has(value) ? value : null
}

// Valida o --advisor contra a whitelist. Retorna o valor ou null (= sem flag).
export function resolveAdvisor(value: string | null | undefined): string | null {
  return value && SPAWN_ADVISOR_WHITELIST.has(value) ? value : null
}
