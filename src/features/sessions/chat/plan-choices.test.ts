import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseTuiMenu, type TuiMenu } from '../tui-menu-parser'
import { planAcceptsFeedback, planApprovalMode, planChoices } from './plan-choices'

const real = (name: string): TuiMenu =>
  parseTuiMenu(
    readFileSync(
      join(__dirname, '../../../../shared/tui/__fixtures__', `claude-2.1.317-${name}.txt`),
      'utf8',
    ),
  )!

const summary = (menu: TuiMenu) =>
  planChoices(menu).map((c) => [c.intent, c.label, c.tone, c.highlighted])

describe('planChoices — capturas reais do claude 2.1.317', () => {
  it('default: auto destacado, manual como ação principal', () => {
    expect(summary(real('plan-default'))).toEqual([
      ['approve-auto', 'Aprovar e ligar auto mode', 'secondary', true],
      ['approve-manual', 'Aprovar com edições manuais', 'primary', false],
    ])
    expect(planAcceptsFeedback(real('plan-default'))).toBe(true)
  })

  it('no-auto', () => {
    expect(summary(real('plan-no-auto'))[0]).toEqual([
      'approve-accept-edits',
      'Aprovar e aceitar edições automaticamente',
      'secondary',
      true,
    ])
  })

  it('clear-context diz o quanto do contexto está em uso e o modo que liga', () => {
    expect(summary(real('plan-clear-context'))[0]).toEqual([
      'approve-clear-context',
      'Aprovar, limpar contexto (8% usado) e ligar auto mode',
      'secondary',
      true,
    ])
  })

  it('cursor no campo de feedback: nenhuma aprovação destacada', () => {
    expect(planChoices(real('plan-feedback-input')).some((c) => c.highlighted)).toBe(false)
  })

  it('bypass é ação de alerta (variante do binário, sem captura)', () => {
    const menu =
      parseTuiMenu(` Claude has written up a plan and is ready to execute. Would you like to proceed?
 ❯ 1. Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session
   2. Yes, manually approve edits
   3. Tell Claude what to change
      shift+tab to approve with this feedback
`)!
    expect(summary(menu)[0]).toEqual(['approve-bypass', 'Aprovar e ligar bypass', 'danger', true])
    expect(planChoices(menu).map((c) => c.confirm)).toEqual([true, false])
  })
})

describe('planApprovalMode — o modo que o pill assume após decidir pelo card', () => {
  it('cada aprovação liga o seu modo; descartar não muda nada', () => {
    const menu = real('plan-default')
    expect(planApprovalMode(menu, 'approve-manual')).toBe('default')
    expect(planApprovalMode(menu, 'approve-auto')).toBe('auto')
    expect(planApprovalMode(menu, 'feedback')).toBeNull()
    expect(planApprovalMode(menu, 'reject')).toBeNull()
  })

  it('accept-edits e bypass mapeiam pro PermissionMode da CLI', () => {
    const menu = real('plan-default')
    expect(planApprovalMode(menu, 'approve-accept-edits')).toBe('acceptEdits')
    expect(planApprovalMode(menu, 'approve-bypass')).toBe('bypassPermissions')
  })

  it('limpar contexto liga o modo dito na própria opção', () => {
    expect(planApprovalMode(real('plan-clear-context'), 'approve-clear-context')).toBe('auto')
  })
})
