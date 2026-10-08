import { gateMenuByStatus, parseTuiMenu, type TuiMenu } from './tui-menu-parser'
import { parseWithGrowingWindow } from './tui-read-window'

// POR QUE uma sessão está na fila de atenção. É só enfeite: nunca decide se a
// sessão entra/sai da fila nem se notifica — isso continua no status do
// ~/.claude/sessions/<pid>.json. Motivo ausente = exatamente o comportamento de antes.
export type AttentionReason = 'permission' | 'trust' | 'question' | 'turn-end' | 'handoff-input'

export type LiveStatus = 'starting' | 'working' | 'waiting' | 'idle' | 'ended'

export interface ScreenScan {
  menu: TuiMenu | null
  // Caixa de input ociosa do claude (❯ entre as réguas) — prova de fim de turno.
  inputPrompt: boolean
  // Texto do usuário na caixa de input (não o placeholder esmaecido). Só quem
  // enxerga os atributos de célula sabe: o texto puro dos dois é igual em forma.
  inputDirty?: boolean
  nonBlankLines: number
}

const PROMPT_WINDOW = 40
// Abaixo disso a tela ainda está nascendo (banner) — não é falha de parse.
const UNPARSED_MIN_LINES = 3

const RULE_RE = /^─{10,}$/
const INPUT_LINE_RE = /^❯(\s|$)/

// Caixa de input do claude 2.1.286 (captura real em __fixtures__/…idle-prompt):
// régua, "❯ …", régua. A linha ❯ de uma opção de menu não tem régua logo acima.
export function hasInputPrompt(text: string): boolean {
  const lines = text.split('\n').map((l) => l.trim())
  for (let i = lines.length - 1; i > 0; i--) {
    if (!INPUT_LINE_RE.test(lines[i]) || !RULE_RE.test(lines[i - 1])) continue
    if (lines.slice(i + 1, i + 8).some((l) => RULE_RE.test(l))) return true
  }
  return false
}

// Linhas da caixa de input, de baixo pra cima: a linha ❯ logo abaixo de uma régua,
// com outra régua até 8 linhas abaixo. Devolve [linha ❯, linha da régua de baixo).
export function inputBoxRows(lines: string[]): { start: number; end: number } | null {
  const trimmed = lines.map((l) => l.trim())
  for (let i = trimmed.length - 1; i > 0; i--) {
    if (!INPUT_LINE_RE.test(trimmed[i]) || !RULE_RE.test(trimmed[i - 1])) continue
    const close = trimmed.slice(i + 1, i + 8).findIndex((l) => RULE_RE.test(l))
    if (close >= 0) return { start: i, end: i + 1 + close }
  }
  return null
}

export interface InputCell {
  chars: string
  dim: boolean
}

// O claude 2.1.286 desenha o placeholder ("Try \"…\"") com SGR 2 (dim) e o que o
// usuário digitou com atributo normal (capturas input-placeholder / input-dirty).
// Qualquer caractere visível não-dim depois do ❯ é texto que o \r enviaria junto.
export function inputBoxHasUserText(rows: InputCell[][]): boolean {
  return rows.some((cells, r) => {
    const from = r === 0 ? cells.findIndex((c) => c.chars === '❯') + 1 : 0
    return cells.slice(Math.max(0, from)).some((c) => c.chars.trim() !== '' && !c.dim)
  })
}

export function scanScreen(readTail: (lines: number) => string, bufferLines: number): ScreenScan {
  const menu = parseWithGrowingWindow(readTail, parseTuiMenu, bufferLines)
  const tail = readTail(PROMPT_WINDOW)
  return {
    menu,
    inputPrompt: menu == null && hasInputPrompt(tail),
    nonBlankLines: tail.split('\n').filter((l) => l.trim() !== '').length,
  }
}

function menuReason(menu: TuiMenu): AttentionReason {
  if (menu.kind === 'permission' || menu.kind === 'trust') return menu.kind
  return 'question'
}

export interface ReasonInput {
  status: LiveStatus
  // null = nenhuma PTY deste app observada para a sessão.
  scan: ScreenScan | null
  handoffAsking: boolean
}

export function deriveAttentionReason({
  status,
  scan,
  handoffAsking,
}: ReasonInput): AttentionReason | undefined {
  if (handoffAsking) return 'handoff-input'
  if (!scan) return undefined
  const menu = gateMenuByStatus(scan.menu, status)
  if (menu) return menuReason(menu)
  if (status === 'waiting' && scan.inputPrompt) return 'turn-end'
  return undefined
}

// A sessão espera você e a tela tem conteúdo, mas nada foi reconhecido: é o
// sinal de drift do parser (nova versão da CLI) que o contador expõe.
export function isUnparsedWaiting(status: LiveStatus, scan: ScreenScan): boolean {
  return (
    status === 'waiting' &&
    !scan.menu &&
    !scan.inputPrompt &&
    scan.nonBlankLines > UNPARSED_MIN_LINES
  )
}

// Fonte única da regra de retomada: o needs_input vale até a filha registrar
// progresso depois da pergunta. A projeção de atenção (shared/attention) e o
// crewResumedAfterQuestion do renderer leem daqui.
export function handoffAsking(h: {
  status: string
  questionAskedAt: number | null
  stepUpdatedAt: number | null
}): boolean {
  if (h.status !== 'needs_input') return false
  if (h.questionAskedAt == null || h.stepUpdatedAt == null) return true
  return h.stepUpdatedAt <= h.questionAskedAt
}
