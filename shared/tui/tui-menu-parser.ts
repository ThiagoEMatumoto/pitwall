// Parser PURO do menu interativo da TUI do claude a partir do texto plano do
// tail do buffer do xterm (readTailText no Terminal). É a fonte do "momento
// pendente" no modo chat: a CLI (2.1.212) NÃO grava o tool_use de
// AskUserQuestion/ExitPlanMode no JSONL enquanto pendente — só após a resposta —
// então o transcript nunca expõe a pergunta aberta; o buffer sim.
//
// Formato real (validação live + strings do binário; pode driftar entre versões):
//   [chip/header]
//   Pergunta em bold
//   ❯ 1. Opção A
//        descrição/wrap indentado
//     2. Opção B
//     3. Type something.        ← sentinela __other__
//     4. Chat about this        ← sentinela __chat__
//   Enter to select · ↑/↓ to navigate · Esc to cancel
//
// Menu de plano: "Would you like to proceed?" / "Exit plan mode?". No 2.1.317
// (capturas __fixtures__/claude-2.1.317-plan-*) as opções variam com a config:
// "Yes, and use auto mode" / "Yes, auto-accept edits" / "Yes, clear context (N%
// used) and use auto mode" / "Yes, manually approve edits" e, por último, o campo
// "Tell Claude what to change" (+ linha "shift+tab to approve with this feedback").
// Versões antigas tinham "No, keep planning". Cada opção leva o seu planIntent.
//
// Prompts TTY-only (NUNCA vão pro JSONL, nem depois da resposta): permissão de
// tool ("Do you want to …?" + opções Yes/No) e trust de diretório ("Only proceed
// if you trust this configuration." + "Yes, I trust this folder" etc.). Mesmo
// shape numerado; classificados como kind 'permission'/'trust', com o box acima
// da pergunta (diff/comando) capturado em `context`.
//
// FAIL-CLOSED em tudo: qualquer dúvida no parse → null (a UI degrada pro banner
// "responda no terminal"). Nunca renderizar clique sobre um parse incerto.

import { isInputRule } from './input-rule'
import { parseWithGrowingWindow, TAIL_WINDOWS } from './tui-read-window'

export interface TuiMenuOption {
  // Índice 0-based da opção; o dígito exibido na TUI (e enviado no clique) é
  // index + 1 — o handler de dígito da CLI seleciona E submete (single-select
  // sem preview) ou apenas move o cursor (com preview) / faz toggle (multi).
  index: number
  label: string
  description?: string
  sentinel?: 'other' | 'chat'
  // Multi-select apenas: estado do checkbox `[ ]`/`[✔]` lido do buffer.
  // undefined em single-select (sem checkbox na linha da opção).
  checked?: boolean
  // Bloco de preview/exemplo (┌─...─┐) associado à opção ATUALMENTE destacada
  // (❯) — a TUI só desenha o preview pra opção com o cursor; muda ao navegar
  // (validado ao vivo). Bordas de box-drawing já removidas.
  preview?: string
  // Só no menu de plano: o que a opção faz, lido da forma/posição (não só do label:
  // o label do campo de feedback vira o texto que o usuário está digitando).
  planIntent?: PlanIntent
  // approve-clear-context: o modo de permissão que vale depois de limpar o contexto.
  planMode?: PlanMode
  // Só no menu de plano: o dígito submete esta opção? O campo de feedback só ganha foco.
  submitOnDigit?: boolean
  // Other (sentinel 'other') com texto já digitado no terminal: o label vira esse texto
  // (2.1.317, capturas question-multi-other-typed / single-other-typed). Mandar mais
  // texto concatenaria nele.
  otherText?: string
  // Menus fora do AskUserQuestion (kind 'menu'/'nudge'): a opção abre um campo de texto
  // ao receber o cursor ("Summarize from here: add context (optional)" no /rewind). Com o
  // cursor nela, dígito e letra viram texto (captura rewind-digit-into-input).
  opensInput?: boolean
  // kind 'menu': cabeçalho não selecionável acima da opção (evento do /hooks: "PreToolUse
  // before tool execution"). O cursor da CLI pula essas linhas.
  group?: string
}

export type PlanMode = 'auto' | 'accept-edits' | 'manual' | 'bypass'

export type PlanIntent =
  | 'approve-auto'
  | 'approve-accept-edits'
  | 'approve-manual'
  | 'approve-bypass'
  | 'approve-clear-context'
  | 'feedback'
  | 'keep-planning'

// Uma aba da barra de abas (multi-pergunta/multi-select): "←  ☒ Rótulo  ☐
// Rótulo  ✔ Submit  →" — validado ao vivo contra claude 2.1.215. `done` reflete
// o glyph ☒ (alguma seleção feita nessa pergunta) vs ☐ (nada marcado ainda); a
// aba "Submit" sempre chega com done:true (glyph ✔), mas não é usada pra lógica.
export interface TuiMenuTab {
  label: string
  done: boolean
}

export interface PermissionRequest {
  // "Bash command" → Bash; "Edit file" → Edit (cabeçalho da caixa da TUI).
  tool?: string
  // Conteúdo entre as réguas ╌ (2.1.286) ou o alvo de "make this edit to X".
  command?: string
}

// 'menu': diálogo que nenhum parser dedicado reconhece (/permissions, /hooks, seletor e
// submenu do /rewind), lido pelo parser tolerante. 'nudge': o "Teach auto mode about your
// environment?" do 2.1.317, que aparece com a sessão idle depois do turno.
export interface TuiMenu {
  kind: 'question' | 'plan' | 'permission' | 'trust' | 'question_review' | 'menu' | 'nudge'
  question?: string
  // permission/trust: linhas do box ACIMA da pergunta (diff/comando/config).
  // question_review: resumo "pergunta → resposta" da tela de revisão.
  // Aparadas de bordas de box-drawing. Fail-soft: se nada legível sobrar, ausente.
  context?: string
  // permission: o pedido estruturado (ferramenta + comando) lido do mesmo box do
  // context. Ausente quando nada foi reconhecido — quem consome cai no context.
  request?: PermissionRequest
  options: TuiMenuOption[]
  // Multi-select: dígito faz TOGGLE (marca/desmarca), nunca submete — a UI
  // precisa dos controles de aba/revisão em vez de clique direto.
  multiSelect: boolean
  // Barra de abas (>4 opções → CLI quebra em várias perguntas; multiSelect
  // SEMPRE tem pelo menos [pergunta, Submit], mesmo com uma pergunta só —
  // validado ao vivo). Ausente = sem abas (single-select comum).
  tabs?: TuiMenuTab[]
  // false quando o menu exige Enter separado pra submeter (preview/notes
  // presente no buffer) — dígito só navega/toggla. true = comportamento
  // pré-existente (dígito seleciona E submete), preservado pra single-select
  // sem preview.
  submitOnDigit: boolean
  // Opção com o pointer ❯ agora (0-based). Fora do fingerprint: muda ao navegar.
  cursorIndex?: number
  // Rodapé "Tab to amend" (2.1.316): a opção sob o cursor aceita um texto junto.
  amendable?: boolean
  // 'arrows': opções sem número — responder é andar do cursorIndex até a opção e
  // dar Enter (dígito não faz nada). Ausente = dígito, o padrão dos menus numerados.
  navigation?: 'arrows'
  // permission/trust: a janela lida acabou antes da régua do topo do prompt, então
  // o context é só o fim do diff. Quem lê o buffer amplia a janela (parseTuiMenuFull).
  contextClipped?: boolean
  // plan: arquivo do plano lido do rodapé "ctrl+g to edit in … · ~/.claude/plans/x.md".
  // É a fonte do conteúdo do card: o input.plan do JSONL pode trazer o plano anterior.
  planFile?: string
  // Multi-select do 2.1.317: linha "Submit" sem número logo abaixo da última opção antes
  // da régua (capturas question-multi-*). afterIndex = opção logo acima dela; focused =
  // o ❯ está nela (aí cursorIndex fica ausente). Enter nela abre a revisão.
  submitRow?: { afterIndex: number; focused: boolean }
  // kind 'menu'/'nudge': rodapé de teclas como a TUI escreveu ("Enter to view · Esc to close").
  footer?: string
  // Rodapé com "←/→ to switch": as abas (tabs) trocam por seta lateral.
  tabSwitch?: boolean
  // Rodapé com "↓ to select" (sem "Enter/"): o foco está nas abas, não na lista; o 1º ↓
  // pousa na opção 1 (capturas unknown-permissions-down e populated-permissions-list).
  listFocusKey?: boolean
  // kind 'menu': a lista rolou ("↑ 10 more"/"↓ 11 more" do /hooks, "↑ N."/"↓ N." do
  // /permissions). As opções lidas são só a janela visível.
  moreAbove?: boolean
  moreBelow?: boolean
  // kind 'menu': texto do campo de busca do /permissions (ausente = vazio, "Search…").
  search?: string
}

// Linha de opção numerada: pointer opcional (❯), UM dígito, ponto, label.
// Um dígito só: AskUserQuestion tem no máx. 4 opções + 2 sentinelas e o handler
// de dígito da CLI cobre '1'..'9'. Pointer capturado (grupo 1) pra achar qual
// opção está destacada — é a que ganha o preview, quando presente.
const OPTION_RE = /^\s*(❯)?\s*(\d)\.\s+(.+)$/
// Rodapé/linhas de status toleradas DEPOIS da última opção (não invalidam o menu).
// "Esc to go back" é o rodapé dos prompts de permissão/trust (strings do binário).
const FOOTER_RE =
  /Enter to (select|confirm)|to navigate|Esc to cancel|Esc to go back|Space to toggle|to select all|shift\+tab|ctrl\+/i
// Continuação (descrição/wrap) da última opção: indentada além do "N. ".
const CONTINUATION_RE = /^\s{3,}\S/
// MultiSelect: rodapé de checkbox (versões antigas) OU glyph `[ ]`/`[✔]` real
// nas opções (validado ao vivo contra claude 2.1.215 — o rodapé mudou pra
// "Tab/Arrow keys to navigate" e não menciona mais "Space to toggle").
const MULTI_SELECT_RE = /Space to toggle/i
// Checkbox de multi-select: opção desmarcada `[ ]`, marcada `[✔]` (glyph exato
// do binário — NÃO é o `☐/☑` genérico).
const CHECKBOX_RE = /^\[( |✔)\]\s*(.*)$/
// Barra de abas de multi-pergunta/multi-select: sempre tem pelo menos a
// pergunta atual + "Submit" (mesmo com uma pergunta só, sem split — validado
// ao vivo). Glyph por aba: `☒` (com seleção), `☐` (vazia), `✔` (aba Submit).
const TAB_BAR_RE = /^←\s+(.+?)\s+→$/
const TAB_TOKEN_RE = /^(☒|☐|✔)\s+(.+)$/
// Tela de revisão final (aba "Submit"): título fixo + resumo pergunta→resposta
// + opções numeradas "Submit answers"/"Cancel".
const QUESTION_REVIEW_RE = /Review your answers/i
// Caracteres de moldura do box de preview/exemplo (┌─...─┐ ao lado da opção
// destacada) — qualquer linha que contenha um destes é conteúdo do preview,
// nunca descrição da opção.
const BOX_CHAR_RE = /[┌┐└┘│]/
const BOX_INTERIOR_RE = /│(.*)│/
// Dica de notas do preview — sinaliza (junto com o próprio box) que o menu
// exige Enter separado pra submeter (regra validada na Fase 0).
const NOTES_HINT_RE = /to add notes/i
// Separador horizontal sem indentação, tolerado DEPOIS da última opção —
// apareceu na validação live (claude 2.1.215) antes de "Chat about this"
// quando o menu tem preview/notes; CONTINUATION_RE não cobre (0 indentação).
// Em sessão nomeada (claude 2.1.295+, toda filha de handoff) a régua da caixa de
// input logo abaixo do menu embute o nome: "──────── nome ─". Mesmo shape do
// isInputRule do PR #310; o rótulo não pode ter caractere de caixa.
const SEPARATOR_RE = /^─{3,}(?:\s+[^\s─│┼┬┴├┤╭╮╰╯](?:[^─│┼┬┴├┤╭╮╰╯]*[^\s─│┼┬┴├┤╭╮╰╯])?\s+─+)?$/
// "Chat about this" às vezes perde o número quando o menu tem preview/notes
// (artefato de layout observado ao vivo — o box de preview desloca a
// numeração) — tolerado sem dígito na zona pós-última-opção; não é clicável
// de qualquer forma (sentinela 'chat' já é filtrado no wiring).
const UNNUMBERED_SENTINEL_RE = /^(Type something\.?|Chat about this\.?)$/
// Linha "Submit" do multi-select do 2.1.317 (sem número, recuada sob a última opção).
const SUBMIT_ROW_RE = /^(❯\s*)?Submit$/
// Chip/header truncado acima da pergunta (campo `header` da tool AskUserQuestion,
// prefixado por um glyph de checkbox — observado ao vivo no 2.1.216, sonda
// Fase 0). Nunca faz parte do texto da pergunta — é um rótulo curto à parte.
const CHIP_RE = /^☐\s+\S/
// Prompt de permissão de tool (y/n): headings "Do you want to make this edit to
// …" / "Do you want to proceed?" / "run this command unsandboxed" etc. — todos
// casam o genérico /Do you want/. Opções com strings exatas do binário 2.1.212.
const PERMISSION_QUESTION_RE = /Do you want/i
const PERMISSION_OPTION_RE = /don[’']t ask again|allow all edits|No, and tell Claude/i
// Trust prompt de diretório: heading real é "Only proceed if you trust this
// configuration." (+ "This folder adds …"); opções exatas do binário.
const TRUST_HEADING_RE = /trust this configuration|trust this folder/i
const TRUST_OPTION_RE = /I trust this folder|remember this directory|No, continue without these permissions/i
// Classificação do menu de plano (labels exatos vistos no binário da CLI).
const PLAN_QUESTION_RE = /Would you like to proceed|Exit plan mode/i
// Só os labels que nenhum outro menu usa classificam sozinhos. Os do 2.1.317 ("Yes,
// and use auto mode", "Yes, clear context", "Tell Claude what to change") cabem numa
// opção escrita pelo modelo ou numa permissão: exigem a pergunta do diálogo.
const PLAN_OPTION_RE = /^Yes, auto-accept edits|^Yes, manually approve|^No, keep planning/i
const PLAN_FEEDBACK_LABEL_RE = /^Tell Claude what to change$/i
const PLAN_FEEDBACK_HINT_RE = /approve with this feedback/i
const PLAN_KEEP_PLANNING_RE = /^No, keep planning/i
// Depois de salvar no editor o rodapé ganha " · ✔ Plan saved!".
const PLAN_FILE_RE = /ctrl\+g to edit in .+? · (.+?\.md)(?: · .*)?\s*$/

// Bordas de box-drawing (moldura do box de diff/comando) aparadas do contexto.
// ╌ é a moldura tracejada do comando no prompt de permissão do 2.1.286.
const BOX_EDGE_RE = /^[\s│╭╮╰╯─╌]+|[\s│╭╮╰╯─╌]+$/g
// No 2.1.286 o prompt não tem box ╭: começa numa régua cheia de ─ (captura real
// em shared/tui/__fixtures__) — acima dela é conversa. Pode trazer o nome da sessão.

// Teto de linhas acima da pergunta. Era 15: um Edit de 10 linhas no 2.1.316 já
// desenha ~35 (contexto + − + +), e o card mostrava só o fim do diff, sem o
// arquivo (captura real __fixtures__/claude-2.1.316-permission-edit-long-diff).
// O limite real é a régua do topo do prompt; o teto só protege de tela sem régua.
const CONTEXT_MAX_LINES = 300

function isContextTop(raw: string): boolean {
  return raw.includes('╭') || isInputRule(raw.trim())
}

// Bloco de contexto do prompt de permissão/trust: linhas ACIMA da pergunta (o
// box com o diff/comando/config que o usuário está aprovando). Para na borda
// superior do box (╭) ou na régua cheia. `clipped`: o texto acabou antes disso.
function extractContext(
  lines: string[],
  questionLine: number,
  max = CONTEXT_MAX_LINES,
): { context?: string; clipped: boolean } {
  const parts: string[] = []
  let i = questionLine - 1
  for (; i >= 0 && i >= questionLine - max; i--) {
    const raw = lines[i]
    if (isContextTop(raw)) {
      const cleaned = raw.replace(BOX_EDGE_RE, '')
      if (cleaned !== '' && !isInputRule(raw.trim())) parts.unshift(cleaned)
      break
    }
    const cleaned = raw.replace(BOX_EDGE_RE, '')
    if (cleaned !== '') parts.unshift(cleaned)
  }
  return { ...(parts.length > 0 ? { context: parts.join('\n') } : {}), clipped: i < 0 }
}

// Cabeçalho da caixa no 2.1.286 ("Bash command") e nos prompts de arquivo ("Edit file").
const TOOL_HEADER_RE = /^(\S+) (command|file)$/i
// MCP no 2.1.316 (captura real …permission-mcp): cabeçalho "Tool use" e, logo
// abaixo, "<servidor> — <Ferramenta> Tool: (MCP)"; os argumentos ficam entre as ╌.
const MCP_TOOL_RE = /^(.+?) Tool: \(MCP\)$/
// Fica logo acima da pergunta: identifica o MCP quando o argumento longo empurrou
// o cabeçalho para fora da tela lida.
const MCP_ABOUT_RE = /^About the (.+? — .+?) Tool:$/
const DASHED_RULE_RE = /^╌{10,}$/
const EDIT_TARGET_RE = /^Do you want to make this edit to (.+)\?$/i

// Mesma janela do extractContext, mas lendo a estrutura que ele descarta: no
// 2.1.286 (captura real em __fixtures__/…permission-bash) o comando fica entre
// duas réguas ╌, abaixo do cabeçalho e da descrição.
function extractRequest(
  lines: string[],
  questionLine: number,
  question: string | undefined,
  max = CONTEXT_MAX_LINES,
): PermissionRequest | undefined {
  let tool: string | undefined
  let aboutTool: string | undefined
  let filePath: string | undefined
  const rules: number[] = []
  for (let i = questionLine - 1; i >= 0 && i >= questionLine - max; i--) {
    const t = lines[i].trim()
    if (DASHED_RULE_RE.test(t)) rules.unshift(i)
    const cleaned = t.replace(BOX_EDGE_RE, '')
    const header = TOOL_HEADER_RE.exec(cleaned)
    if (header && !tool) {
      tool = header[1]
      // "Edit file" / "Create file": o caminho vem na linha de baixo, e o que fica
      // entre as réguas é o diff — não serve de "comando".
      if (/^file$/i.test(header[2])) filePath = lines[i + 1]?.trim().replace(BOX_EDGE_RE, '') || undefined
    }
    const mcp = MCP_TOOL_RE.exec(cleaned)
    if (mcp && !tool) tool = mcp[1]
    const about = MCP_ABOUT_RE.exec(cleaned)
    if (about && !aboutTool) aboutTool = about[1]
    if (isContextTop(lines[i])) break
  }
  tool ??= aboutTool
  let command: string | undefined = filePath
  if (!command && rules.length >= 2) {
    const body = lines
      .slice(rules[rules.length - 2] + 1, rules[rules.length - 1])
      // 2.1.316: cada linha do comando vem com a calha "│ " dentro das réguas ╌.
      .map((l) => l.trim().replace(/^│\s?/, ''))
      .filter((l) => l !== '')
    if (body.length > 0) command = body.join(' ')
  }
  if (!command && question) command = EDIT_TARGET_RE.exec(question)?.[1]
  if (!tool && !command) return undefined
  return { ...(tool ? { tool } : {}), ...(command ? { command } : {}) }
}

const SENTINELS: [RegExp, 'other' | 'chat'][] = [
  [/^Type something\.?$/, 'other'],
  [/^Chat about this\.?$/, 'chat'],
]

// Resultado de varrer uma faixa de linhas ENTRE (ou depois d)a(s) opção(ões):
// separa texto de descrição de conteúdo de preview/notas — nunca mistura os
// dois (o box de preview não é descrição da opção).
interface ScanResult {
  descParts: string[]
  previewParts: string[]
  hasNotesHint: boolean
  submit?: 'focused' | 'idle'
}

function scanBetween(lines: string[], from: number, to: number): ScanResult {
  const descParts: string[] = []
  const previewParts: string[] = []
  let hasNotesHint = false
  let submit: ScanResult['submit']
  for (let i = from; i < to; i++) {
    const raw = lines[i]
    const t = raw.trim()
    if (t === '') continue
    // Régua do 2.1.317 entre o Other e "Chat about this": não é descrição de ninguém.
    if (SEPARATOR_RE.test(t)) continue
    const sm = SUBMIT_ROW_RE.exec(t)
    if (sm) {
      submit = sm[1] ? 'focused' : 'idle'
      continue
    }
    if (NOTES_HINT_RE.test(raw)) {
      hasNotesHint = true
      continue
    }
    if (BOX_CHAR_RE.test(raw)) {
      const m = BOX_INTERIOR_RE.exec(raw)
      const inner = m?.[1]?.trim()
      if (inner) previewParts.push(inner)
      continue
    }
    descParts.push(t)
  }
  return { descParts, previewParts, hasNotesHint, ...(submit ? { submit } : {}) }
}

// Barra de abas: sobe a partir da pergunta tolerando linhas em branco; para no
// primeiro não-branco. Se não bater com TAB_BAR_RE, não há abas (fail-soft).
function extractTabBar(lines: string[], questionLine: number, max = 6): TuiMenuTab[] | undefined {
  for (let i = questionLine - 1, seen = 0; i >= 0 && seen < max; i--, seen++) {
    const t = lines[i].trim()
    if (t === '') continue
    const m = TAB_BAR_RE.exec(t)
    if (!m) return undefined
    const tabs: TuiMenuTab[] = []
    for (const tok of m[1].split(/\s{2,}/).map((s) => s.trim()).filter(Boolean)) {
      const tm = TAB_TOKEN_RE.exec(tok)
      if (!tm) return undefined
      tabs.push({ label: tm[2].trim(), done: tm[1] !== '☐' })
    }
    return tabs.length > 0 ? tabs : undefined
  }
  return undefined
}

// Pergunta: junta as linhas de wrap CONTÍGUAS (sem blank entre elas) da
// pergunta acima da 1ª opção — a TUI quebra perguntas longas em várias linhas
// visuais SEM inserir blank entre si (validado ao vivo, sonda Fase 0, claude
// 2.1.216); junta com espaço pra reconstituir a prosa corrida. Primeiro pula
// blank(s) imediatamente acima das opções (alguns layouts inserem um — 2.1.212)
// até achar a última linha visual da pergunta (a "âncora"); dali sobe juntando
// enquanto for não-branco e não for chip (CHIP_RE), barra de abas
// (TAB_BAR_RE) ou linha de moldura de box (permission/trust: o diff/comando
// acima da pergunta usa ╭╮╰╯─│, nunca é wrap da pergunta) — `max` limita o
// pior caso (blank/chip/box ausentes) pra não engolir conversa anterior.
const BOX_DRAWING_RE = /[┌┐└┘│╭╮╰╯─╌]/
function extractQuestion(
  lines: string[],
  firstOptionLine: number,
  max = 12,
): { question?: string; questionLine: number } {
  let i = firstOptionLine - 1
  while (i >= 0 && lines[i].trim() === '') i--
  if (i < 0) return { questionLine: firstOptionLine }
  const parts: string[] = []
  let questionLine = i
  for (let seen = 0; i >= 0 && seen < max; i--, seen++) {
    const t = lines[i].trim()
    if (t === '' || CHIP_RE.test(t) || TAB_BAR_RE.test(t) || BOX_DRAWING_RE.test(t)) break
    parts.unshift(t)
    questionLine = i
  }
  return { question: parts.length > 0 ? parts.join(' ') : undefined, questionLine }
}

// Resumo "pergunta → resposta" da tela de revisão: linhas entre o título
// "Review your answers" e a pergunta final ("Ready to submit your answers?").
function extractReviewSummary(lines: string[], questionLine: number): string | undefined {
  let reviewLine = -1
  for (let i = questionLine - 1; i >= 0; i--) {
    if (QUESTION_REVIEW_RE.test(lines[i])) {
      reviewLine = i
      break
    }
  }
  if (reviewLine < 0) return undefined
  const parts: string[] = []
  for (let i = reviewLine + 1; i < questionLine; i++) {
    const t = lines[i].trim()
    if (t !== '') parts.push(t)
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

export function parseTuiMenu(text: string): TuiMenu | null {
  const lines = text.split('\n')
  // Ignora linhas em branco no fim (o viewport abaixo do desenho da TUI).
  let end = lines.length
  while (end > 0 && lines[end - 1].trim() === '') end--
  if (end === 0) return null
  return parseNumberedMenu(lines, end) ?? parseUnnumberedTrust(lines, end) ?? parseGenericMenu(lines, end)
}

// Trust de diretório do 2.1.286+ (captura real __fixtures__/claude-2.1.286-trust-
// unnumbered.ansi): as opções perderam o número ("❯ No, exit" / "Yes, I trust
// this folder") e o rodapé é "Enter to confirm · Esc to cancel". O 2.1.316 desenha
// a mesma tela; validado ao vivo (sandbox-084): dígito não faz nada, a seta move o
// ❯ e Enter confirma. O destaque inicial é "No, exit" — Enter cego encerraria a
// sessão —, então o menu leva o cursor lido e a resposta anda a partir dele.
const UNNUMBERED_TRUST_OPTION_RE = /^(?:❯\s*)?(?:Yes, I trust this folder|No, exit)$/
const TRUST_SAFETY_RE = /Quick safety check|one you trust/i
const ACCESSING_RE = /^Accessing workspace:?$/i

function parseUnnumberedTrust(lines: string[], end: number): TuiMenu | null {
  let i = end - 1
  if (!FOOTER_RE.test(lines[i])) return null
  i--
  while (i >= 0 && lines[i].trim() === '') i--
  const optionLines: string[] = []
  while (i >= 0 && UNNUMBERED_TRUST_OPTION_RE.test(lines[i].trim())) {
    optionLines.unshift(lines[i].trim())
    i--
  }
  if (!optionLines.some((l) => /I trust this folder/.test(l))) return null
  const cursor = optionLines.findIndex((l) => l.startsWith('❯'))

  const above = lines.slice(Math.max(0, i - 20), i + 1).map((l) => l.trim())
  const qStart = above.findIndex((l) => TRUST_SAFETY_RE.test(l))
  let question: string | undefined
  if (qStart >= 0) {
    const qEnd = above.indexOf('', qStart)
    question = above.slice(qStart, qEnd < 0 ? undefined : qEnd).join(' ')
  }
  const aStart = above.findIndex((l) => ACCESSING_RE.test(l))
  const workspace =
    aStart >= 0
      ? above
          .slice(aStart + 1, qStart > aStart ? qStart : undefined)
          .filter((l) => l !== '')
          .join('')
      : ''
  return {
    kind: 'trust',
    ...(question ? { question } : {}),
    ...(workspace ? { context: `Accessing workspace: ${workspace}` } : {}),
    options: optionLines.map((l, index) => ({ index, label: l.replace(/^❯\s*/, '') })),
    multiSelect: false,
    submitOnDigit: false,
    navigation: 'arrows',
    ...(cursor >= 0 ? { cursorIndex: cursor } : {}),
  }
}

// Ordem importa: "auto-accept edits" contém "auto", e o clear-context termina no modo.
function planModeOf(label: string): PlanMode | undefined {
  if (/bypass permissions/i.test(label)) return 'bypass'
  if (/auto-accept edits/i.test(label)) return 'accept-edits'
  if (/manually approve/i.test(label)) return 'manual'
  if (/auto mode/i.test(label)) return 'auto'
  return undefined
}

// A dica "shift+tab to approve with this feedback" fica abaixo da última opção (no
// rodapé, não na descrição) e continua lá depois que o label vira o texto digitado.
function planIntentOf(
  option: TuiMenuOption,
  isLast: boolean,
  cursorIndex: number | undefined,
  footer: string,
): Pick<TuiMenuOption, 'planIntent' | 'planMode'> {
  if (PLAN_FEEDBACK_LABEL_RE.test(option.label) || (isLast && PLAN_FEEDBACK_HINT_RE.test(footer)))
    return { planIntent: 'feedback' }
  if (PLAN_KEEP_PLANNING_RE.test(option.label)) return { planIntent: 'keep-planning' }
  if (/^Yes\b/i.test(option.label)) {
    const mode = planModeOf(option.label)
    if (!mode) return {}
    if (/^Yes, clear context\b/i.test(option.label)) return { planIntent: 'approve-clear-context', planMode: mode }
    return { planIntent: `approve-${mode}` }
  }
  // Sem a linha de dica, o campo de feedback com texto digitado só se reconhece por
  // ser o último e estar com o cursor (digitar exige o foco nele).
  if (isLast && cursorIndex === option.index) return { planIntent: 'feedback' }
  return {}
}

function classifyPlanOptions(
  options: TuiMenuOption[],
  cursorIndex: number | undefined,
  footer: string,
): TuiMenuOption[] {
  return options.map((o, k) => {
    const intent = planIntentOf(o, k === options.length - 1, cursorIndex, footer)
    if (!intent.planIntent) return o
    return { ...o, ...intent, submitOnDigit: intent.planIntent !== 'feedback' }
  })
}

function parseNumberedMenu(lines: string[], end: number): TuiMenu | null {
  const text = lines.join('\n')

  // Todas as linhas numeradas do tail (pointer ❯ capturado pra achar a opção
  // destacada, dona do preview quando presente).
  const numbered: { line: number; digit: number; rest: string; pointer: boolean }[] = []
  for (let i = 0; i < end; i++) {
    const m = OPTION_RE.exec(lines[i])
    if (m) numbered.push({ line: i, digit: Number(m[2]), rest: m[3].trim(), pointer: m[1] != null })
  }
  if (numbered.length < 2) return null

  // Run ascendente CONTÍGUA terminando na última linha numerada — listas
  // markdown acima do menu quebram a run (o dígito não continua a sequência).
  let runStart = numbered.length - 1
  while (runStart > 0 && numbered[runStart - 1].digit === numbered[runStart].digit - 1) runStart--
  const run = numbered.slice(runStart)
  // Menu scrollado (não começa em 1) ou run de 1 item só → não é um menu íntegro.
  if (run.length < 2 || run[0].digit !== 1) return null

  // O menu precisa terminar perto do fim do texto: depois da última opção só
  // continuação indentada (descrição/wrap), branco, rodapé, separador sem
  // indentação ou conteúdo de preview/notas (validado ao vivo — apareceram
  // nessa zona quando o menu tem preview). Qualquer outra linha = o menu não é
  // o elemento ativo do fundo → fail-closed.
  const last = run[run.length - 1]
  for (let i = last.line + 1; i < end; i++) {
    const l = lines[i]
    const t = l.trim()
    if (t === '') continue
    if (FOOTER_RE.test(l)) continue
    if (CONTINUATION_RE.test(l)) continue
    if (SEPARATOR_RE.test(t)) continue
    if (BOX_CHAR_RE.test(l) || NOTES_HINT_RE.test(l)) continue
    if (UNNUMBERED_SENTINEL_RE.test(t)) continue
    if (SUBMIT_ROW_RE.test(t)) continue
    return null
  }

  // Linhas não-numeradas ENTRE opções = descrição da opção anterior OU
  // conteúdo de preview/notas — nunca os dois misturados.
  let previewParts: string[] = []
  let hasNotesHint = false
  let submitRow: TuiMenu['submitRow']
  const options: TuiMenuOption[] = run.map((entry, k) => {
    const next = k + 1 < run.length ? run[k + 1].line : last.line + 1
    const scanned = scanBetween(lines, entry.line + 1, next)
    previewParts = previewParts.concat(scanned.previewParts)
    hasNotesHint = hasNotesHint || scanned.hasNotesHint
    if (scanned.submit) submitRow = { afterIndex: entry.digit - 1, focused: scanned.submit === 'focused' }

    // Checkbox de multi-select: "[ ] Label" / "[✔] Label".
    const cb = CHECKBOX_RE.exec(entry.rest)
    const checked = cb ? cb[1] === '✔' : undefined
    let label = cb ? cb[2].trim() : entry.rest
    // Preview iniciado NA MESMA linha da opção ("Label                ┌──…" ou
    // "Label                 │ conteúdo │"): corta a moldura fora do label e,
    // se essa mesma linha já traz conteúdo de interior (│texto│), captura.
    const boxIdx = label.search(BOX_CHAR_RE)
    if (boxIdx >= 0) {
      const boxPart = label.slice(boxIdx)
      const inner = BOX_INTERIOR_RE.exec(boxPart)?.[1]?.trim()
      if (inner) previewParts.push(inner)
      label = label.slice(0, boxIdx).trimEnd()
    }

    const sentinel = SENTINELS.find(([re]) => re.test(label))?.[1]
    return {
      index: entry.digit - 1,
      label,
      ...(scanned.descParts.length > 0 ? { description: scanned.descParts.join(' ') } : {}),
      ...(sentinel ? { sentinel } : {}),
      ...(checked != null ? { checked } : {}),
    }
  })
  // O conteúdo do box de preview costuma cair DEPOIS da última opção numerada
  // (o box é mais alto que a lista de opções restante) — já tolerado no loop
  // de fail-close acima; aqui só extrai o preview/notas dessa zona (descParts
  // descartado: rodapé/separador/sentinela não-numerada não são descrição de
  // ninguém).
  const tailScan = scanBetween(lines, last.line + 1, end)
  previewParts = previewParts.concat(tailScan.previewParts)
  hasNotesHint = hasNotesHint || tailScan.hasNotesHint
  if (tailScan.submit) submitRow = { afterIndex: last.digit - 1, focused: tailScan.submit === 'focused' }
  markTypedOther(options)
  // Preview coletado (entre opções + depois da última) pertence à opção com o
  // pointer ❯ (a TUI só desenha o preview pra opção destacada) — sem pointer
  // identificável, cai fail-soft na última opção.
  if (previewParts.length > 0) {
    const pointerIdx = run.findIndex((e) => e.pointer)
    const highlightIdx = pointerIdx >= 0 ? pointerIdx : options.length - 1
    options[highlightIdx] = { ...options[highlightIdx], preview: previewParts.join('\n') }
  }

  // Pergunta: junta as linhas de wrap contíguas acima da 1ª opção (ver
  // extractQuestion) — não só a última.
  const { question, questionLine } = extractQuestion(lines, run[0].line)

  // Classificação com precedência review > plan > trust > permission >
  // question. AskUserQuestion sempre desenha as sentinelas (Type
  // something./Chat about this); um menu COM sentinela nunca é
  // permissão/trust — mesmo que a pergunta do usuário contenha "Do you
  // want"/"trust this folder" (fail-closed contra falso positivo em cima de
  // texto de conversa).
  const isReview = QUESTION_REVIEW_RE.test(text)
  const hasSentinel = options.some((o) => o.sentinel != null)
  const isPlan =
    !isReview &&
    !hasSentinel &&
    ((question != null && PLAN_QUESTION_RE.test(question)) ||
      options.some((o) => PLAN_OPTION_RE.test(o.label)))
  const isTrust =
    !isReview &&
    !isPlan &&
    !hasSentinel &&
    (options.some((o) => TRUST_OPTION_RE.test(o.label)) ||
      (question != null && TRUST_HEADING_RE.test(question)))
  const isPermission =
    !isReview &&
    !isPlan &&
    !isTrust &&
    !hasSentinel &&
    (options.some((o) => PERMISSION_OPTION_RE.test(o.label)) ||
      (question != null && PERMISSION_QUESTION_RE.test(question)))

  // Diálogo numerado que não é AskUserQuestion (sem sentinela): o nudge do auto mode e o
  // submenu de restaurar do /rewind (capturas 2.1.317) liam como 'question' e o card
  // oferecia "responder" um menu da própria CLI. Vão para o parser tolerante.
  if (
    !isReview &&
    !isPlan &&
    !isTrust &&
    !isPermission &&
    !hasSentinel &&
    isCliDialog(question, lines, run[0].line, footerOf(lines, last.line, end))
  )
    return parseGenericMenu(lines, end, true)

  const kind: TuiMenu['kind'] = isReview
    ? 'question_review'
    : isPlan
      ? 'plan'
      : isTrust
        ? 'trust'
        : isPermission
          ? 'permission'
          : 'question'

  // Contexto: box de diff/comando (permission/trust) ou resumo de respostas
  // (question_review). Nos demais kinds não faz sentido.
  const boxed =
    kind === 'permission' || kind === 'trust' ? extractContext(lines, questionLine) : null
  const context = boxed
    ? boxed.context
    : kind === 'question_review'
      ? extractReviewSummary(lines, questionLine)
      : undefined
  const cursorIdx = run.findIndex((e) => e.pointer)
  const footer = lines.slice(last.line + 1, end).join('\n')

  const request =
    kind === 'permission' ? extractRequest(lines, questionLine, question ?? undefined) : undefined
  const tabs = kind === 'question' ? extractTabBar(lines, questionLine) : undefined
  const multiSelect = MULTI_SELECT_RE.test(text) || options.some((o) => o.checked != null)
  // Preview/notas presente → dígito só navega/toggla, precisa de Enter
  // separado pra submeter (regra validada na Fase 0).
  const submitOnDigit = previewParts.length === 0 && !hasNotesHint
  const cursorIndex = cursorIdx >= 0 ? options[cursorIdx].index : undefined
  const planFile = kind === 'plan' ? PLAN_FILE_RE.exec(footer.trimEnd())?.[1] : undefined

  return {
    kind,
    ...(kind === 'question_review' ? { question: 'Review your answers' } : question != null ? { question } : {}),
    ...(context != null ? { context } : {}),
    ...(request != null ? { request } : {}),
    options: kind === 'plan' ? classifyPlanOptions(options, cursorIndex, footer) : options,
    multiSelect,
    ...(tabs != null ? { tabs } : {}),
    submitOnDigit,
    ...(cursorIndex != null ? { cursorIndex } : {}),
    ...(/Tab to amend/i.test(footer) ? { amendable: true } : {}),
    ...(boxed?.clipped ? { contextClipped: true } : {}),
    ...(planFile && !planFile.includes('…') ? { planFile } : {}),
    ...(kind === 'question' && multiSelect && submitRow ? { submitRow } : {}),
  }
}

function footerOf(lines: string[], lastOptionLine: number, end: number): string {
  return lines.slice(lastOptionLine + 1, end).join('\n')
}

// O Other com texto digitado perde o label "Type something" (vira o texto). No
// AskUserQuestion ele é sempre a opção logo acima de "Chat about this".
// Um Other digitado com o texto "Chat about this" casa a sentinela pelo label: só a
// última opção com ele é a sentinela de verdade (no AskUserQuestion ela vem por último).
function markTypedOther(options: TuiMenuOption[]): void {
  let lastChat = -1
  options.forEach((o, i) => {
    if (o.sentinel === 'chat') lastChat = i
  })
  options.forEach((o, i) => {
    if (o.sentinel !== 'chat' || i === lastChat) return
    const copy = { ...o }
    delete copy.sentinel
    options[i] = copy
  })
  if (options.some((o) => o.sentinel === 'other')) return
  const chat = options.findIndex((o) => o.sentinel === 'chat')
  if (chat < 1) return
  const prev = options[chat - 1]
  if (prev.sentinel != null) return
  options[chat - 1] = { ...prev, sentinel: 'other', otherText: prev.label }
}

const NUDGE_TITLE_RE = /^Teach auto mode about your environment\?$/
const REWIND_CONFIRM_RE = /^Confirm you want to restore\b/
// O AskUserQuestion escreve "Enter to select"; os Select da própria CLI, "Enter to confirm".
const CLI_DIALOG_FOOTER_RE = /Enter to confirm/i
// Abas e busca do /permissions (capturas populated-permissions-*): a aba Ask/Deny com 2+
// regras é uma run numerada a partir de 1 e lia como 'question'. O AskUserQuestion navega
// abas com "Tab/Arrow keys", nunca escreve estas dicas.
const CLI_TABS_FOOTER_RE = /←\/→ to switch|↑ to tabs|Type to filter|(?:^|·\s*)↓ to select/i

function isCliDialog(
  question: string | undefined,
  lines: string[],
  firstOptionLine: number,
  footer: string,
): boolean {
  // O multi-select antigo (2.1.212) também dizia "Enter to confirm", junto do "Space to toggle".
  if (CLI_DIALOG_FOOTER_RE.test(footer) && !MULTI_SELECT_RE.test(footer)) return true
  if (CLI_TABS_FOOTER_RE.test(footer)) return true
  if (question != null && NUDGE_TITLE_RE.test(question)) return true
  for (let i = firstOptionLine - 1; i >= Math.max(0, firstOptionLine - 15); i--) {
    const t = lines[i].trim()
    if (NUDGE_TITLE_RE.test(t) || REWIND_CONFIRM_RE.test(t)) return true
    if (isInputRule(t)) break
  }
  return false
}

// --- Parser tolerante (kind 'menu'/'nudge') ---------------------------------------
// Diálogos da CLI que nenhum parser dedicado conhece (capturas 2.1.317 unknown-*,
// rewind-*, auto-mode-env-nudge): régua cheia no topo, título, texto, opções com ou
// sem número, rodapé de teclas com Esc. Só lê o que a tela mostra; quem decide se dá
// pra clicar é buildGenericSelectKeys (cursor conhecido, campo de texto, número).
const GENERIC_FOOTER_RE = /Esc to (cancel|close|go back|exit|clear)/i
const GENERIC_MAX_LINES = 45
const TAB_SWITCH_RE = /←\/→ to switch/i
// "Enter/↓ to select" é o rodapé da busca com texto: o ↓ dali pousa numa opção que a sonda
// não conseguiu prever (populated-menus, 1ª rodada), então não conta.
const LIST_FOCUS_RE = /(?:^|·\s*)↓ to select/i
// A barra de abas também existe com o foco na busca, que não troca de aba ("↑ to tabs").
const TABS_HINT_RE = /←\/→ to switch|↑ to tabs/i
// Tela só de leitura (detalhe de hook, regra de fonte read-only): o rodapé é só o Esc e o
// título é um dos capturados (populated-hooks-detail, populated-permissions-rule-readonly).
// Fora deles, tela sem opção nem aba segue sem menu.
const READONLY_FOOTER_RE = /^Esc to (cancel|go back|close)$/i
const READONLY_TITLE_RE = /^(Command hook|Rule details)$/
const SEARCH_BOX_RE = /⌕\s*(.*?)\s*│?$/
const SEARCH_PLACEHOLDER_RE = /^Search…?$/
const INPUT_OPTION_RE = /^(Type something|Summarize from here|Tell Claude what to change)\b|\(optional\)$/i
// Descrição sob a mensagem no seletor do /rewind: mesma indentação do label, não é parada.
const REWIND_DESC_RE = /^(No code changes|\d+ files? changed\b.*)$/i
const CURSOR_LINE_RE = /^(\s*)❯\s+(\S.*)$/
const GENERIC_BOX_RE = /^[╭╰│]/
// Com `"tui": "fullscreen"` no settings do usuário a CLI abre o diálogo com uma régua de ▔
// (U+2594) em vez de ─ (drive-app, claude 2.1.318); a caixa de input segue com ─.
const FULLSCREEN_TOP_RULE_RE = /^▔{10,}$/

function isDialogTopRule(line: string): boolean {
  return isInputRule(line) || FULLSCREEN_TOP_RULE_RE.test(line)
}

// Marcas dos diálogos que têm parser dedicado (permissão, trust, plano, AskUserQuestion).
// Se o dedicado recusou a tela, é drift: o tolerante não pode virar uma aprovação de um
// clique dela, então a tela segue não reconhecida (fallback e contador).
const DEDICATED_DIALOG_RES = [
  PERMISSION_QUESTION_RE,
  PERMISSION_OPTION_RE,
  TRUST_HEADING_RE,
  TRUST_OPTION_RE,
  PLAN_QUESTION_RE,
  PLAN_OPTION_RE,
  PLAN_FEEDBACK_HINT_RE,
  /\b(Type something|Chat about this)\b/,
]
const AMEND_FOOTER_RE = /Tab to amend/i

function looksLikeDedicatedDialog(body: (BodyLine | null)[], footer: string): boolean {
  if (AMEND_FOOTER_RE.test(footer)) return true
  return body.some((b) => b != null && DEDICATED_DIALOG_RES.some((re) => re.test(b.t)))
}

interface BodyLine {
  raw: string
  t: string
  indent: number
}

function parseGenericMenu(lines: string[], end: number, footerOptional = false): TuiMenu | null {
  const footerRaw = lines[end - 1].trim()
  const hasFooter = GENERIC_FOOTER_RE.test(footerRaw)
  if (!hasFooter && !footerOptional) return null
  const bodyEnd = hasFooter ? end - 1 : end
  let top = -1
  for (let i = bodyEnd - 1; i >= Math.max(0, end - GENERIC_MAX_LINES); i--) {
    if (isDialogTopRule(lines[i].trim())) {
      top = i
      break
    }
  }
  if (top < 0) return null
  const body: (BodyLine | null)[] = lines.slice(top + 1, bodyEnd).map((raw) => {
    const t = raw.trim()
    return t === '' ? null : { raw, t, indent: raw.length - raw.trimStart().length }
  })
  // Caixa de input ociosa entre a régua e o rodapé: não é diálogo.
  if (body.some((b) => b != null && /^❯\s*$/.test(b.t))) return null
  if (looksLikeDedicatedDialog(body, hasFooter ? footerRaw : '')) return null
  const first = body.findIndex((b) => b != null)
  if (first < 0) return null

  const parsed = genericNumbered(body) ?? genericUnnumbered(body)
  if (!parsed) return null
  const { options, firstLine, cursorIndex, numbered, moreAbove, moreBelow } = parsed

  const titleLine = body[first]!
  const tabSwitch = hasFooter && TAB_SWITCH_RE.test(footerRaw)
  const listFocusKey = hasFooter && LIST_FOCUS_RE.test(footerRaw)
  let title: string | undefined = first < firstLine ? titleLine.t : undefined
  let tabs: TuiMenuTab[] | undefined
  if (title && hasFooter && TABS_HINT_RE.test(footerRaw)) {
    const tokens = title.split(/\s{2,}/).filter(Boolean)
    if (tokens.length > 1) {
      title = tokens[0]
      tabs = tokens.slice(1).map((label) => ({ label, done: false }))
    }
  }
  // Sem opção nem aba só passa a tela de leitura. O resto é campo de texto ("Add allow
  // permission rule"): como menu ele bloquearia o composer, que é por onde o texto entra.
  const readOnly =
    hasFooter &&
    READONLY_FOOTER_RE.test(footerRaw) &&
    title != null &&
    READONLY_TITLE_RE.test(title) &&
    !body.some((b) => b != null && /^[╭│]/.test(b.t))
  if (options.length === 0 && !tabs && !listFocusKey && !readOnly) return null
  const searchRaw = body
    .map((b) => (b ? SEARCH_BOX_RE.exec(b.t)?.[1] : undefined))
    .find((v) => v != null)
  const search = searchRaw && !SEARCH_PLACEHOLDER_RE.test(searchRaw) ? searchRaw : undefined
  const context = body
    .slice(first + 1, firstLine)
    .filter((b): b is BodyLine => b != null && !/^[╭╰]/.test(b.t) && !/⌕/.test(b.t) && !/^╌+$/.test(b.t))
    .map((b) => b.t.replace(BOX_EDGE_RE, ''))
    .filter((t) => t !== '')
    .join('\n')
  const kind: TuiMenu['kind'] = title && NUDGE_TITLE_RE.test(title) ? 'nudge' : 'menu'
  return {
    kind,
    ...(title ? { question: title } : {}),
    ...(context ? { context } : {}),
    options,
    multiSelect: false,
    submitOnDigit: numbered && !moreAbove,
    ...(cursorIndex != null ? { cursorIndex } : {}),
    // Lista numerada rolada: o dígito de uma janela que não começa em 1 não foi sondado.
    ...(numbered && !moreAbove ? {} : { navigation: 'arrows' as const }),
    ...(tabs ? { tabs } : {}),
    ...(hasFooter ? { footer: footerRaw } : {}),
    ...(tabSwitch ? { tabSwitch: true } : {}),
    ...(listFocusKey ? { listFocusKey: true } : {}),
    ...(moreAbove ? { moreAbove: true } : {}),
    ...(moreBelow ? { moreBelow: true } : {}),
    ...(search ? { search } : {}),
  }
}

// Diálogos da CLI que o tolerante já leu em captura (2.1.317/318). Um 'menu' fora deles é
// tela que nenhum parser conhece: o card ainda serve, mas conta como drift no contador.
const KNOWN_GENERIC_TITLE_RE =
  /^(Rewind|Hooks|Hook events|Command hook|Permissions|Rule details|Delete (allow|ask|deny) tool\?)$/

export function isKnownMenu(menu: TuiMenu): boolean {
  return menu.kind !== 'menu' || KNOWN_GENERIC_TITLE_RE.test(menu.question ?? '')
}

interface GenericOptions {
  options: TuiMenuOption[]
  // Linha (no body) da primeira opção: o que vem acima é título/texto.
  firstLine: number
  cursorIndex?: number
  numbered: boolean
  moreAbove?: boolean
  moreBelow?: boolean
}

function genericOption(index: number, label: string, desc: string[]): TuiMenuOption {
  return {
    index,
    label,
    ...(desc.length > 0 ? { description: desc.join(' ') } : {}),
    ...(INPUT_OPTION_RE.test(label) ? { opensInput: true } : {}),
  }
}

// Opções "N. label" (submenu do /rewind, nudge, regras do /permissions): a run termina
// no fim do body; depois dela só cabe descrição recuada. A lista do /permissions rola e
// marca a borda com a seta no lugar do recuo ("↓ 10. Glob"), já com dois dígitos.
const GENERIC_OPTION_RE = /^\s*(❯)?\s*([↑↓])?\s*(\d{1,2})\.\s+(.+)$/

function genericNumbered(body: (BodyLine | null)[]): GenericOptions | null {
  const rows = body.map((b) => (b ? GENERIC_OPTION_RE.exec(b.raw) : null))
  let lastRow = -1
  for (let i = body.length - 1; i >= 0; i--) {
    if (rows[i]) {
      lastRow = i
      break
    }
  }
  if (lastRow < 0) return null
  const lastIndent = body[lastRow]!.indent
  for (let i = lastRow + 1; i < body.length; i++) {
    const b = body[i]
    if (b && b.indent <= lastIndent + 2) return null
  }
  const num = (i: number) => Number(rows[i]![3])
  const run: number[] = [lastRow]
  for (let i = lastRow - 1; i >= 0; i--) {
    if (!rows[i]) {
      const b = body[i]
      if (b == null || b.indent > lastIndent + 2) continue
      break
    }
    if (num(i) !== num(run[0]) - 1) break
    run.unshift(i)
  }
  const moreAbove = rows[run[0]]![2] === '↑'
  // Janela que não começa em 1 só vale com a seta de rolagem em cima.
  if (num(run[0]) !== 1 && !moreAbove) return null
  if (run.some((line, k) => k > 0 && k < run.length - 1 && rows[line]![2] != null)) return null
  let cursorIndex: number | undefined
  const options = run.map((line, k) => {
    const m = rows[line]!
    const stop = k + 1 < run.length ? run[k + 1] : body.length
    const desc = body.slice(line + 1, stop).filter((b): b is BodyLine => b != null).map((b) => b.t)
    const index = num(line) - 1
    if (m[1]) cursorIndex = index
    return genericOption(index, m[4].trim(), desc)
  })
  return {
    options,
    firstLine: run[0],
    ...(cursorIndex != null ? { cursorIndex } : {}),
    numbered: true,
    ...(moreAbove ? { moreAbove } : {}),
    ...(rows[lastRow]![2] === '↓' ? { moreBelow: true } : {}),
  }
}

// Lista sem número (/hooks, seletor do /rewind): as paradas ficam na coluna do texto
// da linha com ❯. Blocos separados por linha em branco = uma opção por bloco (label +
// descrição, como no /rewind); sem blocos, cada linha é uma opção.
function genericUnnumbered(body: (BodyLine | null)[]): GenericOptions | null {
  const cursorRow = body.findIndex((b) => b != null && CURSOR_LINE_RE.test(b.raw))
  if (cursorRow < 0) {
    // Sem cursor e sem número: nada a clicar; parseGenericMenu só aceita se houver abas.
    return { options: [], firstLine: body.length, numbered: false }
  }
  const cm = CURSOR_LINE_RE.exec(body[cursorRow]!.raw)!
  const col = cm[1].length + 2
  const atCol = (b: BodyLine | null) =>
    b != null && (b.indent === col || CURSOR_LINE_RE.exec(b.raw)?.[1].length === col - 2) && !GENERIC_BOX_RE.test(b.t)
  let from = cursorRow
  while (from > 0 && (body[from - 1] == null || atCol(body[from - 1]))) from--
  while (body[from] == null) from++
  let to = cursorRow + 1
  while (to < body.length && (body[to] == null || atCol(body[to]))) to++
  // "↑ 10 more" / "↓ 11 more" (/hooks rolado) marcam a borda da janela, não são opções.
  const more = { above: false, below: false }
  const region = body.slice(from, to).filter((b) => {
    const m = b ? MORE_RE.exec(b.t) : null
    if (m) more[m[1] === '↑' ? 'above' : 'below'] = true
    return m == null
  })
  const scroll = { ...(more.above ? { moreAbove: true } : {}), ...(more.below ? { moreBelow: true } : {}) }
  if (TAGGED_RE.test(cm[2])) return { ...taggedOptions(region, from), ...scroll }
  const blocks: string[][] = [[]]
  for (const b of region) {
    if (b == null) {
      if (blocks[blocks.length - 1].length > 0) blocks.push([])
      continue
    }
    blocks[blocks.length - 1].push(b.raw)
  }
  if (blocks[blocks.length - 1].length === 0) blocks.pop()
  const grouped = blocks.length > 1
  const entries: string[][] = []
  for (const block of blocks) {
    if (grouped) entries.push(block)
    else for (const raw of block) entries.push([raw])
  }
  // Descrição do /rewind numa lista sem blocos: cola na entrada anterior.
  const merged: string[][] = []
  for (const e of entries) {
    if (merged.length > 0 && REWIND_DESC_RE.test(e[0].trim())) merged[merged.length - 1].push(...e)
    else merged.push([...e])
  }
  let cursorIndex: number | undefined
  const options = merged.map((e, k) => {
    const head = CURSOR_LINE_RE.exec(e[0])
    if (head) cursorIndex = k
    const label = (head ? head[2] : e[0]).trim()
    return genericOption(k, label, e.slice(1).map((l) => l.trim()))
  })
  return { options, firstLine: from, ...(cursorIndex != null ? { cursorIndex } : {}), numbered: false, ...scroll }
}

const MORE_RE = /^([↑↓])\s+\d+\s+more$/
// Linha de hook do /hooks: "[User] comando   matcher · command" (capturas populated-hooks
// e a tela real do usuário, com [User]/[Plugin]). Com o cursor numa delas, as linhas sem
// etiqueta na mesma coluna são o cabeçalho do evento, que o cursor pula.
const TAGGED_RE = /^\[[^\]]+\]\s/
const spaced = (t: string, sep: string) => t.trim().replace(/\s{2,}/g, sep)

function taggedOptions(region: (BodyLine | null)[], from: number): GenericOptions {
  let group: string | undefined
  let cursorIndex: number | undefined
  const options: TuiMenuOption[] = []
  for (const b of region) {
    if (b == null) continue
    const head = CURSOR_LINE_RE.exec(b.raw)
    const text = head ? head[2] : b.t
    if (!TAGGED_RE.test(text)) {
      group = spaced(text, ' — ')
      continue
    }
    if (head) cursorIndex = options.length
    options.push({ index: options.length, label: spaced(text, ' · '), ...(group ? { group } : {}) })
  }
  return { options, firstLine: from, ...(cursorIndex != null ? { cursorIndex } : {}), numbered: false }
}

// Parse de um buffer real: amplia a janela também quando o menu parseou mas o
// diff/comando do prompt começa acima dela — senão o card (e o fingerprint, que
// inclui o context) ficariam com só o fim do diff.
export function parseTuiMenuFull(
  readTail: (lines: number) => string,
  bufferLines: number,
  windows: readonly number[] = TAIL_WINDOWS,
): TuiMenu | null {
  let clipped: TuiMenu | null = null
  const full = parseWithGrowingWindow(
    readTail,
    (text) => {
      const menu = parseTuiMenu(text)
      if (!menu?.contextClipped) return menu
      clipped = menu
      return null
    },
    bufferLines,
    windows,
  )
  return full ?? clipped
}

// Gate PURO de status × kind: em qual status de sessão um menu parseado pode
// virar card no chat. 'waiting' aceita qualquer kind (comportamento F3b). O
// trust prompt aparece ANTES do 1º flush do JSONL — nesse momento a fonte de
// status (~/.claude/sessions/<pid>.json) ou não existe/está sem status
// (mapStatus → 'starting') ou reporta 'idle'; aceitamos os dois SÓ pra
// permission/trust (question/plan continuam exigindo 'waiting' — regressão
// zero). Qualquer outro status → null (fail-closed).
export function gateMenuByStatus(
  menu: TuiMenu | null,
  status: string | undefined,
): TuiMenu | null {
  if (!menu) return null
  if (status === 'waiting') return menu
  if (
    (status === 'starting' || status === 'idle') &&
    (menu.kind === 'permission' || menu.kind === 'trust')
  )
    return menu
  // O nudge do auto mode aparece com a sessão idle, logo depois do turno (captura
  // auto-mode-env-nudge): um Enter do composer ali escolheria "Yes".
  if (status === 'idle' && menu.kind === 'nudge') return menu
  return null
}

// "Pergunta X de Y" pro fluxo de multi-pergunta numa só chamada (Fase 2): a
// barra de abas SEMPRE termina em "Submit" (validado ao vivo, sonda Fase 0/2 —
// ver docs/probe-2116-findings.md); as abas antes dela são as perguntas da
// sequência, `done` vira true assim que cada uma é respondida. Multi-select
// PURO (uma pergunta só, categorias como abas) usa o MESMO shape de `tabs` com
// semântica diferente — por isso `multiSelect` é obrigatório aqui pra não
// rotular "Pergunta 1 de 1" numa tela que não é uma sequência de perguntas.
export function questionPositionLabel(
  tabs: TuiMenuTab[] | undefined,
  multiSelect: boolean,
): string | undefined {
  if (multiSelect || !tabs || tabs.length < 2) return undefined
  const questionTabs = tabs.slice(0, -1) // último item = "Submit"
  if (questionTabs.length < 2) return undefined
  const answered = questionTabs.filter((t) => t.done).length
  const current = Math.min(answered + 1, questionTabs.length)
  return `Pergunta ${current} de ${questionTabs.length}`
}

// Identidade estável de um menu parseado (pergunta + context + labels na ordem).
// Usada pra: (a) não re-renderizar quando o re-parse produz o mesmo menu; (b) guard
// de clique — re-parse fresco divergente do menu clicado → NÃO digitar no PTY.
// O context entra porque no 2.1.286 é o ÚNICO lugar com o comando/diff aprovado:
// sem ele, dois Bash no mesmo cwd têm a mesma identidade.
export function menuFingerprint(menu: TuiMenu): string {
  return [
    menu.kind,
    menu.multiSelect ? 'multi' : 'single',
    menu.question ?? '',
    ...(menu.context?.split('\n').map((l) => `ctx:${l.trim()}`) ?? []),
    ...(menu.tabs?.map((t) => `tab:${t.label}:${t.done}`) ?? []),
    ...menu.options.map((o) => `${o.index}:${o.label}:${o.checked ?? ''}`),
    // \n como separador: nenhum campo pode conter quebra (todos vêm de split('\n')).
  ].join('\n')
}
