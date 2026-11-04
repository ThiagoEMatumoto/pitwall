import type { PermissionMode } from '../../../shared/types/ipc'

// Indicadores que a TUI do Claude Code imprime no rodapé quando um modo de
// permissão está ativo. A negative lookbehind em "accept edits on" evita que
// ele case DENTRO de "auto-accept edits on" (senão o modo 'auto' seria lido
// como 'acceptEdits'). 'default' e 'dontAsk' não têm indicador próprio no
// rodapé — caem no null (caller mantém o anterior).
const MODE_INDICATORS: { re: RegExp; mode: PermissionMode }[] = [
  { re: /(?<!auto-)accept edits on/gi, mode: 'acceptEdits' },
  { re: /plan mode on/gi, mode: 'plan' },
  { re: /(auto-accept edits|auto mode) on/gi, mode: 'auto' },
  { re: /bypass(ing)? permissions/gi, mode: 'bypassPermissions' },
]

// Varre o texto acumulado do PTY pelo indicador de modo MAIS RECENTE (a
// ocorrência mais à direita = o último rodapé renderizado) e retorna o
// PermissionMode correspondente. Retorna null quando nenhum indicador aparece
// — o caller mantém o modo anterior/default. Puro e testável (sem React/estado).
export function parsePermissionMode(text: string): PermissionMode | null {
  let bestIndex = -1
  let bestMode: PermissionMode | null = null
  for (const { re, mode } of MODE_INDICATORS) {
    re.lastIndex = 0
    let lastIndex = -1
    let match: RegExpExecArray | null
    while ((match = re.exec(text)) !== null) {
      lastIndex = match.index
    }
    if (lastIndex > bestIndex) {
      bestIndex = lastIndex
      bestMode = mode
    }
  }
  return bestMode
}

// Detecta o modo a partir do RODAPÉ ATUAL renderizado (não de bytes acumulados). Como o
// modo 'default' não tem indicador, "nenhum indicador no rodapé agora" => 'default'. Use
// sobre as últimas linhas do buffer do xterm: assim cruzar/parar em 'default' é detectável
// (parsePermissionMode-sobre-stream nunca vê default — retém indicadores antigos).
export function detectFooterMode(footer: string): PermissionMode {
  return parsePermissionMode(footer) ?? 'default'
}

// Leitura do rodapé pro pill com um menu TUI possivelmente aberto. O diálogo de plano e o
// prompt de permissão tomam o lugar do rodapé: ali "sem indicador" não prova 'default', só
// um indicador explícito conta. null = manter o modo atual (sem toast de mudança falsa).
export function footerModeUpdate(footer: string, menuOpen: boolean): PermissionMode | null {
  return parsePermissionMode(footer) ?? (menuOpen ? null : 'default')
}

// Decide se uma mudança de `currentMode` (Terminal.tsx) merece o banner efêmero de
// transição. `prev` null cobre DOIS casos que nunca notificam: o estado inicial
// (ainda não detectamos nada) e a PRIMEIRA detecção real (baseline, não é uma
// "mudança" que o usuário fez — é só a leitura inicial do rodapé). Só dispara quando
// já tínhamos um modo real anterior e ele difere do novo. Puro/testável (sem timers).
export function shouldNotifyModeChange(
  prev: PermissionMode | null,
  next: PermissionMode | null,
): boolean {
  return prev != null && next != null && prev !== next
}
