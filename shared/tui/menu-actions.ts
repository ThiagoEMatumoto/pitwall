import type { AttentionAction } from '../types/ipc'
import {
  AMEND_KEY_DELAY_MS,
  buildAmendKeys,
  buildChatKeys,
  buildEscKey,
  buildGenericInputKeys,
  buildGenericSelectKeys,
  buildGenericTabKeys,
  buildMultiSubmitKeys,
  buildPlanKeys,
  buildQuestionOtherKeys,
  buildQuestionTabKeys,
  buildSelectKeys,
  buildToggleKeys,
  GENERIC_INPUT_KEY_DELAY_MS,
  PLAN_KEY_DELAY_MS,
  QUESTION_KEY_DELAY_MS,
} from './respond-keys'
import type { TuiMenu } from './tui-menu-parser'

// Uma ação da UI (card do chat, popover de atenção, cartões da Room) vira as teclas do
// menu FRESCO. Fonte única: o main (tui-menu-watch) e o renderer chamam daqui.
// [] = a ação não cabe neste menu; quem chama não digita nada.
export function keysForAction(menu: TuiMenu, action: AttentionAction): string[] {
  // Plano só por intent: o dígito cru do campo de feedback só o foca, e aprovar
  // precisa ser a opção que o usuário leu.
  if (menu.kind === 'plan' || action.kind === 'plan') {
    return menu.kind === 'plan' && action.kind === 'plan'
      ? buildPlanKeys(menu, action.intent, action.text)
      : []
  }
  if (action.kind === 'esc') return buildEscKey()
  if (menu.kind === 'menu' || menu.kind === 'nudge') {
    if (action.kind === 'select') return buildGenericSelectKeys(menu, action.optionIndex)
    if (action.kind === 'tab') return buildGenericTabKeys(menu, action.direction)
    if (action.kind === 'other') return buildGenericInputKeys(menu, action.optionIndex, action.text)
    return []
  }
  if (action.kind === 'tab') return buildQuestionTabKeys(menu, action.direction)
  // Várias perguntas numa chamada (abas sem multi-select): sem captura no 2.1.317.
  if (!menu.multiSelect && menu.tabs) return []
  if (action.kind === 'chat') return buildChatKeys(menu)
  if (action.kind === 'submit-multi') return buildMultiSubmitKeys(menu)
  const opt = menu.options.find((o) => o.index === action.optionIndex)
  if (!opt || opt.sentinel === 'chat') return []
  if (action.kind === 'toggle') {
    return menu.multiSelect && opt.sentinel == null ? buildToggleKeys(opt.index, menu) : []
  }
  if (action.kind === 'other') {
    return opt.sentinel === 'other' ? buildQuestionOtherKeys(menu, opt.index, action.text) : []
  }
  if (menu.multiSelect) return []
  if (action.kind === 'amend') {
    return opt.sentinel == null ? buildAmendKeys(menu, opt.index, action.text) : []
  }
  return opt.sentinel === 'other' ? [] : buildSelectKeys(menu, opt.index)
}

export function actionKeyDelay(menu: TuiMenu, action: AttentionAction): number | undefined {
  if (action.kind === 'amend') return AMEND_KEY_DELAY_MS
  if (action.kind === 'plan') return PLAN_KEY_DELAY_MS
  if (menu.kind === 'menu' && action.kind === 'other') return GENERIC_INPUT_KEY_DELAY_MS
  if (menu.kind === 'question' && (action.kind === 'other' || action.kind === 'submit-multi'))
    return QUESTION_KEY_DELAY_MS
  return undefined
}

// Ação que não fecha o menu (o mesmo diálogo continua na tela, com outro estado): quem
// mostra o menu relê em vez de dar a resposta por enviada.
export function isStepAction(menu: TuiMenu, action: AttentionAction): boolean {
  if (action.kind === 'toggle' || action.kind === 'tab') return true
  return action.kind === 'other' && menu.kind === 'question' && menu.multiSelect
}
