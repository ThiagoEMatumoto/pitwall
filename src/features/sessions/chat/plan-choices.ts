import type { PlanIntent, PlanMode, TuiMenu, TuiMenuOption } from '../tui-menu-parser'

// Um botão por opção real do diálogo de plano, com o modo que a aprovação liga
// dito por extenso: "Aprovar plano" sozinho escondia que a opção 1 liga o auto mode.
export interface PlanChoice {
  intent: Exclude<PlanIntent, 'feedback'>
  label: string
  // Label original da TUI (tooltip): o usuário pode conferir o que vai ser escolhido.
  optionLabel: string
  // A opção sob o ❯ no terminal: é a que um Enter escolheria lá.
  highlighted: boolean
  tone: 'primary' | 'secondary' | 'danger'
}

const MODE_TAIL: Record<PlanMode, string> = {
  auto: 'ligar auto mode',
  'accept-edits': 'aceitar edições automaticamente',
  manual: 'aprovar edições manualmente',
  bypass: 'ligar bypass',
}

function choiceLabel(o: TuiMenuOption): string | null {
  switch (o.planIntent) {
    case 'approve-auto':
      return 'Aprovar e ligar auto mode'
    case 'approve-accept-edits':
      return 'Aprovar e aceitar edições automaticamente'
    case 'approve-manual':
      return 'Aprovar com edições manuais'
    case 'approve-bypass':
      return 'Aprovar e ligar bypass'
    case 'approve-clear-context': {
      const used = /\((\d+)% used\)/.exec(o.label)?.[1]
      const ctx = used ? `limpar contexto (${used}% usado)` : 'limpar contexto'
      return o.planMode ? `Aprovar, ${ctx} e ${MODE_TAIL[o.planMode]}` : null
    }
    case 'keep-planning':
      return 'Continuar planejando'
    default:
      return null
  }
}

function toneOf(o: TuiMenuOption): PlanChoice['tone'] {
  if (o.planIntent === 'approve-bypass' || o.planMode === 'bypass') return 'danger'
  return o.planIntent === 'approve-manual' ? 'primary' : 'secondary'
}

export function planChoices(menu: TuiMenu): PlanChoice[] {
  if (menu.kind !== 'plan') return []
  const out: PlanChoice[] = []
  for (const o of menu.options) {
    const label = choiceLabel(o)
    if (!label || !o.planIntent || o.planIntent === 'feedback') continue
    // Intent repetido não tem tecla segura (findPlanOption devolve null).
    if (menu.options.filter((x) => x.planIntent === o.planIntent).length > 1) continue
    out.push({
      intent: o.planIntent,
      label,
      optionLabel: o.label,
      highlighted: menu.cursorIndex === o.index,
      tone: toneOf(o),
    })
  }
  return out
}

export function planAcceptsFeedback(menu: TuiMenu): boolean {
  return menu.kind === 'plan' && menu.options.some((o) => o.planIntent === 'feedback')
}
