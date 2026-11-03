import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildArrowKeys,
  buildCtrlTKey,
  buildDigitKey,
  buildEnterKey,
  buildEscKey,
  buildFilterKeys,
  buildMultiSelectSubmitKeys,
  buildOtherKeys,
  buildPickerSelectKeys,
  buildPlanKeys,
  buildReviewKeys,
  buildSelectKeys,
  buildSpaceKey,
  buildTabKeys,
  buildToggleKeys,
  findPlanOption,
  findReviewOptionIndex,
  playKeys,
} from './respond-keys'
import { parseTuiMenu, type TuiMenu } from '../tui-menu-parser'

const DOWN = '\x1b[B'

describe('buildDigitKey', () => {
  it('turns a 0-based option index into the 1-based TUI digit', () => {
    expect(buildDigitKey(0)).toEqual(['1'])
    expect(buildDigitKey(2)).toEqual(['3'])
    expect(buildDigitKey(8)).toEqual(['9'])
  })

  it('fails closed outside the TUI digit handler range (1..9)', () => {
    expect(buildDigitKey(-1)).toEqual([])
    expect(buildDigitKey(9)).toEqual([])
    expect(buildDigitKey(1.5)).toEqual([])
  })

  it('never emits arrows or Enter (digit selects AND submits)', () => {
    const all = [buildDigitKey(0), buildDigitKey(4), buildDigitKey(8)].flat().join('')
    expect(all).not.toContain(DOWN)
    expect(all).not.toContain('\r')
  })
})

const PLAN_FIXTURES = join(__dirname, '../../../../shared/tui/__fixtures__')

// Tela real do diálogo de plano (claude 2.1.317, sonda probe-chat-plan-2317).
function planFixture(name: string): TuiMenu {
  const menu = parseTuiMenu(readFileSync(join(PLAN_FIXTURES, `claude-2.1.317-${name}.txt`), 'utf8'))
  if (menu?.kind !== 'plan') throw new Error(`${name}: sem menu de plano`)
  return menu
}

const PASTE = (t: string) => `\x1b[200~${t}\x1b[201~`

describe('buildPlanKeys — capturas reais do 2.1.317', () => {
  it('default: auto mode = 1, manual = 2 (o dígito já submete)', () => {
    const menu = planFixture('plan-default')
    expect(buildPlanKeys(menu, 'approve-auto')).toEqual(['1'])
    expect(buildPlanKeys(menu, 'approve-manual')).toEqual(['2'])
    expect(buildPlanKeys(menu, 'approve-accept-edits')).toEqual([])
  })

  it('no-auto: auto-accept edits = 1', () => {
    const menu = planFixture('plan-no-auto')
    expect(buildPlanKeys(menu, 'approve-accept-edits')).toEqual(['1'])
    expect(buildPlanKeys(menu, 'approve-auto')).toEqual([])
    expect(buildPlanKeys(menu, 'approve-manual')).toEqual(['2'])
  })

  it('clear-context: limpar = 1, auto = 2, manual = 3, feedback = 4', () => {
    const menu = planFixture('plan-clear-context')
    expect(buildPlanKeys(menu, 'approve-clear-context')).toEqual(['1'])
    expect(buildPlanKeys(menu, 'approve-auto')).toEqual(['2'])
    expect(buildPlanKeys(menu, 'approve-manual')).toEqual(['3'])
    expect(buildPlanKeys(menu, 'feedback', 'mude')).toEqual(['4', PASTE('mude'), '\r'])
  })

  it('feedback: dígito do campo + paste + Enter (a sequência que a sonda validou)', () => {
    const menu = planFixture('plan-feedback')
    expect(buildPlanKeys(menu, 'feedback', 'adicione também um bye.txt')).toEqual([
      '3',
      PASTE('adicione também um bye.txt'),
      '\r',
    ])
  })

  it('feedback vazio, ou com ESC/quebras no texto, nunca vira Enter cru nem tecla solta', () => {
    const menu = planFixture('plan-feedback')
    expect(buildPlanKeys(menu, 'feedback', '   ')).toEqual([])
    expect(buildPlanKeys(menu, 'feedback')).toEqual([])
    expect(buildPlanKeys(menu, 'feedback', 'a\x1b[201~b\nc')).toEqual([
      '3',
      PASTE('a [201~b c'),
      '\r',
    ])
  })

  it('campo já com texto digitado no terminal: não cola por cima', () => {
    expect(buildPlanKeys(planFixture('plan-feedback-typed'), 'feedback', 'outra coisa')).toEqual([])
  })

  it('o campo focado (sem texto) ainda aceita o feedback', () => {
    expect(buildPlanKeys(planFixture('plan-feedback-input'), 'feedback', 'x')).toEqual([
      '3',
      PASTE('x'),
      '\r',
    ])
  })

  it('rejeitar sem feedback = Esc, de qualquer posição', () => {
    expect(buildPlanKeys(planFixture('plan-default'), 'reject')).toEqual(['\x1b'])
    expect(buildPlanKeys(planFixture('plan-feedback-input'), 'reject')).toEqual(['\x1b'])
  })

  it('aprovar nunca manda Enter (o destaque inicial é o auto mode)', () => {
    for (const name of ['plan-default', 'plan-no-auto', 'plan-clear-context']) {
      const menu = planFixture(name)
      for (const o of menu.options) {
        if (o.planIntent && o.planIntent !== 'feedback')
          expect(buildPlanKeys(menu, o.planIntent).join(''), `${name}:${o.label}`).not.toContain(
            '\r',
          )
      }
    }
  })

  it('fora de um menu de plano, nada', () => {
    const q: TuiMenu = {
      kind: 'question',
      options: [{ index: 0, label: 'Yes, manually approve edits' }],
      multiSelect: false,
      submitOnDigit: true,
    }
    expect(buildPlanKeys(q, 'approve-manual')).toEqual([])
    expect(buildPlanKeys(q, 'reject')).toEqual([])
  })

  it('legado "No, keep planning": dígito da opção', () => {
    const menu =
      parseTuiMenu(`Claude has written up a plan and is ready to execute. Would you like to proceed?

❯ 1. Yes, auto-accept edits
  2. Yes, manually approve edits
  3. No, keep planning

Enter to select · ↑/↓ to navigate · Esc to cancel
`)!
    expect(buildPlanKeys(menu, 'keep-planning')).toEqual(['3'])
    expect(buildPlanKeys(menu, 'feedback', 'x')).toEqual([])
  })

  it('intent repetido é ambíguo: não escolhe', () => {
    const menu = planFixture('plan-default')
    const dup = { ...menu, options: [...menu.options, { ...menu.options[0], index: 3 }] }
    expect(findPlanOption(dup, 'approve-auto')).toBeNull()
    expect(buildPlanKeys(dup, 'approve-auto')).toEqual([])
  })
})

function questionMenu(overrides: Partial<TuiMenu> = {}): TuiMenu {
  return {
    kind: 'question',
    question: 'Qual fruta?',
    options: [
      { index: 0, label: 'Maçã' },
      { index: 1, label: 'Banana' },
    ],
    multiSelect: false,
    submitOnDigit: true,
    ...overrides,
  }
}

describe('buildSelectKeys — clique numa opção single-select', () => {
  it('single sem preview: só o dígito (comportamento pré-existente, seleciona E submete)', () => {
    expect(buildSelectKeys(questionMenu(), 0)).toEqual(['1'])
    expect(buildSelectKeys(questionMenu(), 1)).toEqual(['2'])
  })

  it('single COM preview/notes: dígito + Enter separado (submitOnDigit:false)', () => {
    const menu = questionMenu({ submitOnDigit: false })
    expect(buildSelectKeys(menu, 0)).toEqual(['1', '\r'])
  })

  it('fail-closed fora do range do handler de dígito', () => {
    expect(buildSelectKeys(questionMenu(), 9)).toEqual([])
    expect(buildSelectKeys(questionMenu({ submitOnDigit: false }), 9)).toEqual([])
  })
})

describe('buildSelectKeys — menu navegado por seta (trust sem número do 2.1.316)', () => {
  const trust = (cursorIndex?: number): TuiMenu => ({
    kind: 'trust',
    options: [
      { index: 0, label: 'No, exit' },
      { index: 1, label: 'Yes, I trust this folder' },
    ],
    multiSelect: false,
    submitOnDigit: false,
    navigation: 'arrows',
    cursorIndex,
  })

  it('anda do cursor atual até a opção e confirma com Enter, sem dígito', () => {
    expect(buildSelectKeys(trust(0), 1)).toEqual([DOWN, '\r'])
    expect(buildSelectKeys(trust(1), 0)).toEqual(['\x1b[A', '\r'])
    expect(buildSelectKeys(trust(1), 1)).toEqual(['\r'])
  })

  it('sem cursor lido ou opção inexistente: não digita (Enter cego sairia da sessão)', () => {
    expect(buildSelectKeys(trust(undefined), 1)).toEqual([])
    expect(buildSelectKeys(trust(0), 2)).toEqual([])
  })
})

describe('buildToggleKeys — checkbox de multi-select', () => {
  it('dígito faz toggle, nunca Enter (submeter é só via aba Submit/revisão)', () => {
    expect(buildToggleKeys(0)).toEqual(['1'])
    expect(buildToggleKeys(2)).toEqual(['3'])
  })

  it('fail-closed fora do range', () => {
    expect(buildToggleKeys(9)).toEqual([])
  })
})

describe('buildTabKeys — navegação entre abas', () => {
  it('seta direita/esquerda, nunca outra coisa', () => {
    expect(buildTabKeys('next')).toEqual(['\x1b[C'])
    expect(buildTabKeys('prev')).toEqual(['\x1b[D'])
  })
})

describe('buildMultiSelectSubmitKeys — Bug 3 (multi-select puro sai da tela de checkboxes)', () => {
  it('over-navega N vezes pra direita (N = nº de abas) + Enter, sempre terminando em Enter', () => {
    expect(buildMultiSelectSubmitKeys(2)).toEqual(['\x1b[C', '\x1b[C', '\r'])
    expect(buildMultiSelectSubmitKeys(1)).toEqual(['\x1b[C', '\r'])
  })

  it('fail-closed pra contagem de abas inválida (0, negativa, não-inteira)', () => {
    expect(buildMultiSelectSubmitKeys(0)).toEqual([])
    expect(buildMultiSelectSubmitKeys(-1)).toEqual([])
    expect(buildMultiSelectSubmitKeys(1.5)).toEqual([])
  })

  it('nunca fica só em setas — sem o Enter final o clique repete o Bug 3 (seleciona mas não sai da tela)', () => {
    const keys = buildMultiSelectSubmitKeys(3)
    expect(keys[keys.length - 1]).toBe('\r')
  })
})

describe('findReviewOptionIndex / buildReviewKeys — tela "Review your answers"', () => {
  const review: TuiMenu = {
    kind: 'question_review',
    question: 'Review your answers',
    options: [
      { index: 0, label: 'Submit answers' },
      { index: 1, label: 'Cancel' },
    ],
    multiSelect: false,
    submitOnDigit: true,
  }

  it('acha o índice certo por label (não por posição fixa)', () => {
    expect(findReviewOptionIndex(review, 'submit')).toBe(0)
    expect(findReviewOptionIndex(review, 'cancel')).toBe(1)
  })

  it('buildReviewKeys manda o dígito certo', () => {
    expect(buildReviewKeys(review, 'submit')).toEqual(['1'])
    expect(buildReviewKeys(review, 'cancel')).toEqual(['2'])
  })

  it('fail-closed fora do kind question_review ou sem a opção', () => {
    expect(findReviewOptionIndex(questionMenu(), 'submit')).toBeNull()
    expect(buildReviewKeys(questionMenu(), 'submit')).toEqual([])
  })
})

describe('buildOtherKeys — "Other" (texto livre)', () => {
  it('dígito seleciona a linha + texto digitado + Enter', () => {
    expect(buildOtherKeys(3, 'Neovim')).toEqual(['4', 'Neovim', '\r'])
  })

  it('fail-closed com texto vazio — NUNCA manda Enter sem texto (isso decline)', () => {
    expect(buildOtherKeys(3, '')).toEqual([])
  })

  it('fail-closed fora do range de dígito', () => {
    expect(buildOtherKeys(9, 'algo')).toEqual([])
  })
})

describe('buildArrowKeys — navegação dos pickers de /model e /theme', () => {
  it('repete a sequência validada N vezes (down/up/left/right)', () => {
    expect(buildArrowKeys('down', 2)).toEqual(['\x1b[B', '\x1b[B'])
    expect(buildArrowKeys('up', 1)).toEqual(['\x1b[A'])
    expect(buildArrowKeys('right')).toEqual(['\x1b[C'])
    expect(buildArrowKeys('left', 3)).toEqual(['\x1b[D', '\x1b[D', '\x1b[D'])
  })

  it('fail-closed pra times <= 0', () => {
    expect(buildArrowKeys('down', 0)).toEqual([])
    expect(buildArrowKeys('up', -1)).toEqual([])
  })
})

describe('buildEnterKey / buildEscKey / buildCtrlTKey / buildSpaceKey', () => {
  it('cada builder devolve exatamente a sequência validada', () => {
    expect(buildEnterKey()).toEqual(['\r'])
    expect(buildEscKey()).toEqual(['\x1b'])
    expect(buildCtrlTKey()).toEqual(['\x14'])
    expect(buildSpaceKey()).toEqual([' '])
  })
})

describe('buildFilterKeys — filtro de /config', () => {
  it('texto literal digitado (a TUI filtra ao vivo, sem Enter)', () => {
    expect(buildFilterKeys('verbose')).toEqual(['verbose'])
  })

  it('fail-closed pra texto vazio (nada a digitar)', () => {
    expect(buildFilterKeys('')).toEqual([])
  })
})

describe('buildPickerSelectKeys — clique numa opção de /model ou /theme', () => {
  it('navega do highlight atual até o alvo (down) + Enter aplica', () => {
    expect(buildPickerSelectKeys(0, 2)).toEqual(['\x1b[B', '\x1b[B', '\r'])
  })

  it('navega pra trás (up) quando o alvo está antes do highlight', () => {
    expect(buildPickerSelectKeys(3, 1)).toEqual(['\x1b[A', '\x1b[A', '\r'])
  })

  it('já destacada: só Enter, sem navegar', () => {
    expect(buildPickerSelectKeys(1, 1)).toEqual(['\r'])
  })
})

describe('playKeys', () => {
  it('interleaves writes with sleeps between chunks (never before the first)', async () => {
    const log: string[] = []
    const sleep = (ms: number) => {
      log.push(`sleep:${ms}`)
      return Promise.resolve()
    }
    await playKeys([DOWN, DOWN, '\r'], (s) => log.push(s), 30, sleep)
    expect(log).toEqual([DOWN, 'sleep:30', DOWN, 'sleep:30', '\r'])
  })

  it('writes a single sequence without sleeping', async () => {
    const log: string[] = []
    await playKeys(
      ['\r'],
      (s) => log.push(s),
      30,
      (ms) => {
        log.push(`sleep:${ms}`)
        return Promise.resolve()
      },
    )
    expect(log).toEqual(['\r'])
  })

  it('does nothing for an empty list', async () => {
    const writes: string[] = []
    await playKeys(
      [],
      (s) => writes.push(s),
      30,
      () => Promise.resolve(),
    )
    expect(writes).toEqual([])
  })
})
