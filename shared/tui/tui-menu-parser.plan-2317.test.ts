import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import xtermHeadless from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { parseTuiMenu, parseTuiMenuFull, type TuiMenu } from './tui-menu-parser'

const { Terminal } = xtermHeadless as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal
}

// Capturas reais do claude 2.1.317 (e2e/scenarios/probe-chat-plan-2317.ts, PTY 120x45).
// O .ansi de cada dump guarda só os bytes desde o dump anterior: os primeiros dumps
// de cada sessão reproduzem a tela inteira; os seguintes são lidos pelo .txt.
function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', `claude-2.1.317-${name}`), 'utf8')
}

async function parseAnsiFixture(name: string): Promise<TuiMenu | null> {
  const term = new Terminal({ cols: 120, rows: 45, allowProposedApi: true, scrollback: 2000 })
  await new Promise<void>((resolve) => term.write(fixture(`${name}.ansi`), resolve))
  const readTail = (n: number) => {
    const buf = term.buffer.active
    let text = ''
    for (let y = Math.max(0, buf.length - n); y < buf.length; y++) {
      text += (buf.getLine(y)?.translateToString(true) ?? '') + '\n'
    }
    return text
  }
  return parseTuiMenuFull(readTail, term.buffer.active.length)
}

const shape = (menu: TuiMenu | null) =>
  menu?.options.map((o) => ({
    label: o.label,
    planIntent: o.planIntent,
    ...(o.planMode ? { planMode: o.planMode } : {}),
    submitOnDigit: o.submitOnDigit,
  }))

describe('menu de plano do claude 2.1.317 (capturas reais)', () => {
  it('default/auto: aprovar com auto mode, manual, e o campo de feedback por último', async () => {
    for (const name of [
      'plan-default',
      'plan-auto',
      'plan-feedback',
      'plan-replanned',
      'plan-ctrlg',
    ]) {
      const menu = await parseAnsiFixture(name)
      expect(menu?.kind, name).toBe('plan')
      expect(menu?.cursorIndex, name).toBe(0)
      expect(shape(menu), name).toEqual([
        { label: 'Yes, and use auto mode', planIntent: 'approve-auto', submitOnDigit: true },
        { label: 'Yes, manually approve edits', planIntent: 'approve-manual', submitOnDigit: true },
        { label: 'Tell Claude what to change', planIntent: 'feedback', submitOnDigit: false },
      ])
    }
  })

  it('no-auto (disableAutoMode): auto-accept edits no lugar do auto mode', async () => {
    const menu = await parseAnsiFixture('plan-no-auto')
    expect(menu?.kind).toBe('plan')
    expect(shape(menu)).toEqual([
      { label: 'Yes, auto-accept edits', planIntent: 'approve-accept-edits', submitOnDigit: true },
      { label: 'Yes, manually approve edits', planIntent: 'approve-manual', submitOnDigit: true },
      { label: 'Tell Claude what to change', planIntent: 'feedback', submitOnDigit: false },
    ])
  })

  it('clear-context: a 1ª opção limpa o contexto e liga o auto mode', async () => {
    const menu = await parseAnsiFixture('plan-clear-context')
    expect(menu?.kind).toBe('plan')
    expect(shape(menu)).toEqual([
      {
        label: 'Yes, clear context (8% used) and use auto mode',
        planIntent: 'approve-clear-context',
        planMode: 'auto',
        submitOnDigit: true,
      },
      { label: 'Yes, and use auto mode', planIntent: 'approve-auto', submitOnDigit: true },
      { label: 'Yes, manually approve edits', planIntent: 'approve-manual', submitOnDigit: true },
      { label: 'Tell Claude what to change', planIntent: 'feedback', submitOnDigit: false },
    ])
  })

  it('lê o arquivo do plano do rodapé (ctrl+g to edit in …)', async () => {
    expect((await parseAnsiFixture('plan-default'))?.planFile).toBe(
      '~/.claude/plans/planeje-criar-um-arquivo-structured-pike.md',
    )
    expect((await parseAnsiFixture('plan-feedback'))?.planFile).toBe(
      '~/.claude/plans/planeje-criar-um-arquivo-replicated-penguin.md',
    )
  })

  it('o rodapé com "Plan saved!" depois do Ctrl+G ainda dá o arquivo', () => {
    expect(parseTuiMenu(fixture('plan-ctrlg.txt'))?.planFile).toBe(
      '~/.claude/plans/planeje-criar-um-arquivo-replicated-penguin.md',
    )
  })

  it('campo de feedback focado: cursor na opção 3, ainda feedback', () => {
    const menu = parseTuiMenu(fixture('plan-feedback-input.txt'))
    expect(menu?.kind).toBe('plan')
    expect(menu?.cursorIndex).toBe(2)
    expect(menu?.options[2]).toMatchObject({ planIntent: 'feedback', submitOnDigit: false })
  })

  it('label vira o texto digitado e a opção continua sendo o feedback (pela dica do rodapé)', () => {
    const menu = parseTuiMenu(fixture('plan-feedback-typed.txt'))
    expect(menu?.options[2]).toMatchObject({
      label: 'adicione também um bye.txt',
      planIntent: 'feedback',
      submitOnDigit: false,
    })
    expect(menu?.options[0].planIntent).toBe('approve-auto')
  })

  it('sem a dica, o último com o cursor e label desconhecido ainda é o feedback', () => {
    const text = fixture('plan-feedback-typed.txt').replace(
      'shift+tab to approve with this feedback',
      '                                       ',
    )
    expect(parseTuiMenu(text)?.options[2].planIntent).toBe('feedback')
  })

  it('texto digitado que imita uma aprovação não vira aprovação', () => {
    const text = fixture('plan-feedback-typed.txt').replace(
      'adicione também um bye.txt',
      'Yes, and use auto mode    ',
    )
    expect(parseTuiMenu(text)?.options[2].planIntent).toBe('feedback')
  })

  it('a tela depois de responder não tem menu', async () => {
    for (const name of [
      'plan-default-after-esc',
      'plan-auto-after-approve',
      'plan-no-auto-after-manual',
      'plan-feedback-after-submit',
    ]) {
      expect(parseTuiMenu(fixture(`${name}.txt`)), name).toBeNull()
    }
  })

  it('variantes do binário sem captura: bypass e clear-context com outros modos', () => {
    const menu =
      parseTuiMenu(` Claude has written up a plan and is ready to execute. Would you like to proceed?
 ❯ 1. Yes, clear context (12% used) and bypass permissions
   2. Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session
   3. Yes, clear context (12% used) and auto-accept edits
   4. Yes, manually approve edits
   5. Tell Claude what to change
      shift+tab to approve with this feedback
 ctrl+g to edit in Vim · ~/.claude/plans/x.md
`)
    expect(menu?.options.map((o) => [o.planIntent, o.planMode])).toEqual([
      ['approve-clear-context', 'bypass'],
      ['approve-bypass', undefined],
      ['approve-clear-context', 'accept-edits'],
      ['approve-manual', undefined],
      ['feedback', undefined],
    ])
  })

  it('permissão com "switch to auto mode" continua sendo permissão', () => {
    const menu = parseTuiMenu(
      readFileSync(
        join(__dirname, '__fixtures__', 'claude-2.1.316-named-permission-bash.txt'),
        'utf8',
      ),
    )
    expect(menu?.kind).toBe('permission')
    expect(menu?.options.every((o) => o.planIntent == null)).toBe(true)
  })
})

describe('labels de plano fora do diálogo de plano', () => {
  it('AskUserQuestion com labels de plano continua pergunta', () => {
    for (const labels of [
      ['Yes, and use auto mode', 'Tell Claude what to change'],
      ['Yes, clear context and start over', 'No'],
      ['Yes, manually approve edits', 'No, keep planning'],
    ]) {
      const menu = parseTuiMenu(` Como devo seguir?

 ❯ 1. ${labels[0]}
   2. ${labels[1]}
   3. Type something.
   4. Chat about this

 Enter to select · ↑/↓ to navigate · Esc to cancel
`)
      expect(menu?.kind, labels[0]).toBe('question')
      expect(menu?.options.every((o) => o.planIntent == null), labels[0]).toBe(true)
    }
  })

  it('permissão com "Yes, and use auto mode" continua permissão', () => {
    const menu = parseTuiMenu(` Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and use auto mode
   3. No
`)
    expect(menu?.kind).toBe('permission')
  })
})

describe('AskUserQuestion do claude 2.1.317 (capturas reais)', () => {
  it('single-select com Type something./Chat about this', async () => {
    const menu = await parseAnsiFixture('question-chat-sentinel')
    expect(menu?.kind).toBe('question')
    expect(menu?.options.map((o) => o.sentinel ?? o.label)).toEqual([
      'Python',
      'TypeScript',
      'Go',
      'other',
      'chat',
    ])
    expect(menu?.options.every((o) => o.planIntent == null)).toBe(true)
  })

  it('multi-select: Other é o 4º e o label vira o texto digitado', async () => {
    const menu = await parseAnsiFixture('question-multi-other')
    expect(menu?.kind).toBe('question')
    expect(menu?.multiSelect).toBe(true)
    const typed = parseTuiMenu(fixture('question-multi-other-typed.txt'))
    expect(typed?.options[3].label).toBe('verde agua')
  })

  it('tela de revisão', () => {
    expect(parseTuiMenu(fixture('question-review.txt'))?.kind).toBe('question_review')
  })
})
