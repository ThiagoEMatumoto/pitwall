import type { PlanIntent, TuiMenu, TuiMenuOption } from './tui-menu-parser'

// Tradução dos cliques nos cards interativos do chat (QuestionCard/PlanCard) em
// teclas pro PTY vivo — o mesmo canal write() usado pelo onForwardKey do composer.
//
// Achados de validação LIVE (claude 2.1.212) + strings do binário:
// - O handler de dígitos da TUI (key >= '1' && key <= '9') seleciona E SUBMETE a
//   opção N — confirmado ao vivo (<1,5s, sem Enter). Por isso a resposta é UM
//   dígito, imune ao drift de highlight que tornava setas+Enter frágeis (se o
//   usuário já navegou no menu pelo terminal, o highlight não está no topo).
// - ExitPlanMode: a CONTAGEM e a ORDEM das opções variam entre versões/modos.
//   Cada opção tem o seu planIntent (parser) e a resposta é o dígito dela — ver
//   buildPlanKeys.
// - A fonte do menu é o parse do buffer do xterm (tui-menu-parser): a CLI não
//   grava o tool_use pendente no JSONL, então o transcript não expõe o momento.

// Um clique numa opção vira o dígito dela (1-based na TUI; index aqui é 0-based).
// Fora do range coberto pelo handler da TUI ('1'..'9') → [] (nunca digitar).
export function buildDigitKey(index: number): string[] {
  if (!Number.isInteger(index) || index < 0 || index > 8) return []
  return [String(index + 1)]
}

// Clique numa opção de menu single-select (com ou sem preview). Catálogo
// validado ao vivo (claude 2.1.215): sem preview o dígito já seleciona E
// submete (comportamento pré-existente, preservado); COM preview/notes o
// dígito só move o cursor — precisa de Enter separado, senão a opção fica
// destacada mas nada é enviado.
export function buildSelectKeys(menu: TuiMenu, optionIndex: number): string[] {
  if (menu.navigation === 'arrows') return buildArrowSelectKeys(menu, optionIndex)
  const digit = buildDigitKey(optionIndex)
  if (digit.length === 0) return []
  return menu.submitOnDigit ? digit : [...digit, '\r']
}

// Clique num checkbox de multi-select: dígito faz TOGGLE (marca/desmarca),
// NUNCA submete — validado ao vivo (repetido: '1' marca, '1' de novo
// desmarca, sem sair da tela). Submeter de fato só na aba "Submit" → tela de
// revisão (ver buildReviewKeys). Alias de buildDigitKey só pra deixar a
// intenção explícita nos call sites (toggle ≠ select).
export function buildToggleKeys(optionIndex: number): string[] {
  return buildDigitKey(optionIndex)
}

// Navegação entre abas da barra de multi-pergunta/multi-select — setas
// esquerda/direita, validado ao vivo (`\x1b[C`/`\x1b[D`). Nunca dígito nem
// Enter: trocar de aba não marca nem submete nada.
export function buildTabKeys(direction: 'next' | 'prev'): string[] {
  return [direction === 'next' ? '\x1b[C' : '\x1b[D']
}

// Submete um multi-select PURO (checkboxes marcados, uma pergunta só): o
// parser não expõe qual aba está com o cursor agora (TuiMenuTab só tem
// label/done, sem "aba ativa" — ver tui-menu-parser), então navegamos
// `tabCount` vezes pra DIREITA — suficiente pra chegar em "Submit" venha de
// onde vier, já que over-navegar além do fim CLAMPA sem efeito colateral
// (validado ao vivo, sonda Fase 0: 3 setas num tab bar de 2 abas ainda
// resolveu) — e Enter confirma a entrada na tela de revisão. Sem Enter
// depois da navegação, o clique fica preso em "seleciona mas não envia"
// (Bug 3). NUNCA usado em multi-pergunta (esse fluxo já resolve por
// dígito-por-pergunta + buildReviewKeys no fim, ver findReviewOptionIndex).
export function buildMultiSelectSubmitKeys(tabCount: number): string[] {
  if (!Number.isInteger(tabCount) || tabCount <= 0) return []
  return [...Array(tabCount).fill('\x1b[C'), '\r']
}

// Opções da tela de revisão ("Review your answers") pelo LABEL exato do
// binário — nunca por posição fixa (a ordem/contagem pode variar em teoria,
// mesma cautela de findPlanOption).
const REVIEW_SUBMIT_RE = /^Submit answers$/i
const REVIEW_CANCEL_RE = /^Cancel$/i

export function findReviewOptionIndex(menu: TuiMenu, decision: 'submit' | 'cancel'): number | null {
  if (menu.kind !== 'question_review') return null
  const re = decision === 'submit' ? REVIEW_SUBMIT_RE : REVIEW_CANCEL_RE
  const opt = menu.options.find((o) => re.test(o.label))
  return opt ? opt.index : null
}

// Submete (dígito '1' = "Submit answers") ou cancela ('2' = "Cancel") a
// revisão final do multi-select/multi-pergunta — validado ao vivo. Sem a
// opção parseada (kind errado ou labels mudaram) → [] (fail-closed).
export function buildReviewKeys(menu: TuiMenu, decision: 'submit' | 'cancel'): string[] {
  const idx = findReviewOptionIndex(menu, decision)
  return idx == null ? [] : buildDigitKey(idx)
}

// "Other" (texto livre): dígito seleciona a linha (não abre input, não
// submete), o texto digitado reescreve a label inline, Enter confirma —
// validado ao vivo. Armadilha confirmada: Enter com o campo vazio é lido
// pela TUI como "declinou responder" — por isso texto vazio nunca manda
// Enter (retorna [], fail-closed). O texto pode vir do composer (multilinha): uma
// quebra no meio submeteria a primeira linha e o resto cairia na tela seguinte como
// tecla, por isso controle vira espaço (mesma limpeza do amend).
export function buildOtherKeys(optionIndex: number, text: string): string[] {
  const clean = text.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim()
  if (clean === '') return []
  const digit = buildDigitKey(optionIndex)
  if (digit.length === 0) return []
  return [...digit, clean, '\r']
}

// "Tab to amend" do 2.1.316 (validado ao vivo, sonda probe-chat-permission-2316):
// com o cursor numa opção, Tab abre um campo junto dela ("No, and tell Claude what
// to do differently"), o texto entra ali e Enter envia opção + texto. Dígito não
// serve: ele seleciona E submete. O cursor vem do pointer ❯ do parse fresco; sem
// ele não dá pra saber quantas setas, então nada é digitado.
export function buildAmendKeys(menu: TuiMenu, optionIndex: number, text: string): string[] {
  const clean = text.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim()
  if (clean === '' || !menu.amendable || menu.cursorIndex == null) return []
  if (!menu.options.some((o) => o.index === optionIndex)) return []
  const delta = optionIndex - menu.cursorIndex
  const arrow = delta > 0 ? '\x1b[B' : '\x1b[A'
  return [...Array<string>(Math.abs(delta)).fill(arrow), '\t', clean, '\r']
}

// Entre as teclas do amend: o campo só existe depois que a TUI redesenha o Tab;
// texto que chega antes cai no menu, onde letra pode ser atalho.
export const AMEND_KEY_DELAY_MS = 250

// Diálogo do ExitPlanMode no 2.1.317 (sonda probe-chat-plan-2317, capturas em
// __fixtures__/claude-2.1.317-plan-*): o dígito de uma opção "Yes, …" aprova e já
// troca o modo de permissão; o da última opção só foca o campo de feedback, onde
// o texto entra por bracketed paste e o Enter envia (tool_result is_error com o
// texto como userFeedback). Esc rejeita sem feedback, de qualquer posição. Enter
// cego nunca: o destaque inicial é "Yes, and use auto mode".
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

// Entre as teclas do plano: o campo só existe (ou só sai de foco) depois que a TUI
// redesenha. A sonda esperou 1s; 400ms ficam bem acima do redesenho observado (2-3 ms
// de parse).
export const PLAN_KEY_DELAY_MS = 400

// Opção do menu de plano com esse intent. Duas com o mesmo intent = ambíguo → null.
export function findPlanOption(menu: TuiMenu, intent: PlanIntent): TuiMenuOption | null {
  if (menu.kind !== 'plan') return null
  const found = menu.options.filter((o) => o.planIntent === intent)
  return found.length === 1 ? found[0] : null
}

export function buildPlanKeys(
  menu: TuiMenu,
  intent: PlanIntent | 'reject',
  feedback?: string,
): string[] {
  if (menu.kind !== 'plan') return []
  if (intent === 'reject') return ['\x1b']
  const opt = findPlanOption(menu, intent)
  if (!opt) return []
  const digit = buildDigitKey(opt.index)
  if (digit.length === 0) return []
  // Cursor no campo de feedback = campo com foco, e ali o dígito vira texto (o mesmo
  // Select do /rewind: "Summarize from here: 1", visto ao vivo). ↑ tira o foco.
  const feedbackOpt = findPlanOption(menu, 'feedback')
  const inField = feedbackOpt != null && menu.cursorIndex === feedbackOpt.index
  if (intent !== 'feedback') {
    if (opt.submitOnDigit !== true) return []
    return inField ? ['\x1b[A', ...digit] : digit
  }
  // Mesma limpeza do amend: um ESC no texto fecharia o paste e o resto viraria tecla.
  const clean = (feedback ?? '').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim()
  // Campo já com texto digitado no terminal: o paste concatenaria nele.
  if (clean === '' || !/^Tell Claude what to change$/i.test(opt.label)) return []
  const paste = PASTE_START + clean + PASTE_END
  return inField ? [paste, '\r'] : [...digit, paste, '\r']
}

// --- Pickers de /model, /theme, /config e busca de histórico (Ctrl+R) — Fase 2 ---
// Mesmas primitivas ANSI já usadas acima (setas, Enter, Esc); os pickers só
// compõem elas de um jeito diferente (navegação por seta em vez de dígito).

// Navegação validada ao vivo (claude 2.1.215): /model down×2 move o highlight
// 2 opções; /theme up×2 idem. Repete a MESMA sequência de buildTabKeys N vezes
// — nunca dígito (não testado nesses pickers).
export function buildArrowKeys(direction: 'up' | 'down' | 'left' | 'right', times = 1): string[] {
  if (!Number.isInteger(times) || times <= 0) return []
  const seq = { up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' }[direction]
  return Array(times).fill(seq)
}

// Menu sem número (trust do 2.1.286+): do cursor lido até a opção, depois Enter.
// Sem cursor não há como saber onde o Enter cairia — fail-closed.
function buildArrowSelectKeys(menu: TuiMenu, optionIndex: number): string[] {
  const from = menu.cursorIndex
  if (from == null || !menu.options.some((o) => o.index === optionIndex)) return []
  const delta = optionIndex - from
  return [...buildArrowKeys(delta > 0 ? 'down' : 'up', Math.abs(delta)), '\r']
}

// Enter aplica o picker de /model ou /theme (validado: seleciona o destacado).
export function buildEnterKey(): string[] {
  return ['\r']
}

// Esc cancela qualquer picker desta fase (/model: "Kept model as X"; /theme:
// "Theme picker dismissed"; /config: 1 estágio por clique, ver ChatView; Ctrl+R:
// único caminho validado além de abrir).
export function buildEscKey(): string[] {
  return ['\x1b']
}

// Ctrl+T alterna o preview de sintaxe no picker de /theme — validado ao vivo.
export function buildCtrlTKey(): string[] {
  return ['\x14']
}

// Space alterna um boolean na lista do /config — validado ao vivo. Enums
// (valores que não são "true"/"false") não têm toggle validado — fail-closed,
// não oferecido pelo card (ver tui-picker-parser).
export function buildSpaceKey(): string[] {
  return [' ']
}

// Filtro de busca do /config: texto literal — validado ao vivo (filtra a
// lista em tempo real, sem precisar de Enter nem de apertar "/" antes).
export function buildFilterKeys(text: string): string[] {
  return text === '' ? [] : [text]
}

// Clique numa opção do picker de /model ou /theme: navega do highlight ATUAL
// (vindo do RE-PARSE fresco, nunca do estado antigo — mesma cautela de
// findPlanOption) até o índice clicado via setas, depois Enter aplica.
// Composição de duas primitivas validadas — não é uma tecla nova.
export function buildPickerSelectKeys(currentIndex: number, targetIndex: number): string[] {
  const delta = targetIndex - currentIndex
  if (delta === 0) return buildEnterKey()
  return [...buildArrowKeys(delta > 0 ? 'down' : 'up', Math.abs(delta)), ...buildEnterKey()]
}

// Reproduz as sequências no PTY com um respiro entre elas: a TUI (Ink) processa
// chunks sequencialmente e escapes colados num chunk só podem colapsar num único
// evento de tecla. `sleep` injetável mantém o módulo puro e o teste síncrono.
export async function playKeys(
  seqs: string[],
  write: (s: string) => void,
  delayMs = 30,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  for (let i = 0; i < seqs.length; i++) {
    if (i > 0) await sleep(delayMs)
    write(seqs[i])
  }
}
