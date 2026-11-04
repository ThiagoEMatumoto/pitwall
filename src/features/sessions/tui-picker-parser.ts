// Parser PURO dos pickers modais de /model, /theme, /config e da busca de
// histórico (Ctrl+R) a partir do texto plano do tail do buffer do xterm — Fase
// 2 da cobertura de interações da TUI (ver tui-menu-parser.ts pro trio do
// AskUserQuestion/permission/trust/plan, Fase 1).
//
// Módulo SEPARADO de tui-menu-parser.ts (não editado): estes pickers têm layout
// de tela estruturalmente diferente (barra de tabs, caixa de busca, indicador de
// effort inline, preview de diff/syntax) — misturar no parser de menus
// numerados arriscaria regressão no trio já validado. Zero mudança lá.
//
// Formato real (validação live claude 2.1.215, harness node-pty isolado +
// @xterm/headless pra renderizar snapshots; ver scratchpad da Fase 2 pra
// proveniência completa — sessão descartável, nunca sessão real do usuário):
//
//   /model:  "Select model" (título) + descrição + opções numeradas (mesmo
//            formato ❯ N. label⟨2+ espaços⟩descrição do trio da Fase 1, com
//            "✔" marcando a opção atual) + linha de effort "● High effort
//            (default) ←/→ to adjust" + footer "Enter to set as default · s to
//            use this session only · Esc to cancel". Navegação validada:
//            ↑/↓ move o highlight (NUNCA dígito — não testado); ←/→ ajusta o
//            effort; Enter aplica; Esc cancela ("Kept model as X").
//   /theme:  título "Theme" + descrição fixa + opções numeradas (mesmo
//            formato, "✔" na atual) + separador tracejado ╌ + preview de
//            diff + "Syntax theme: X (ctrl+t to disable)" + footer "Enter to
//            select · Esc to cancel". Navegação: ↑/↓; Ctrl+T alterna o
//            preview; Enter aplica; Esc cancela ("Theme picker dismissed").
//   /config: barra de tabs (Settings/Status/Config/Usage/Stats — só o
//            conteúdo da aba Settings foi validado; trocar de aba É GAP, não
//            implementado) + caixa de busca "⌕ <query>" + lista "label⟨2+
//            espaços⟩valor" (SEM numeração, pointer ❯ no item destacado) +
//            footer que varia por foco: busca → "Type to filter · Enter/↓ to
//            select · ↑ to tabs · Esc to clear"; lista → "Enter/Space to
//            change · / to search · Esc to close". Digitar filtra a lista ao
//            vivo mesmo sem apertar "/" antes (validado: string digitada
//            direto já filtrou). Toggle validado só pra valores exatamente
//            "true"/"false" (Space); enums (ex.: "Manual", "unrestricted") têm
//            comportamento de toggle NÃO validado — GAP, fail-closed
//            (renderizados como não-clicáveis). Esc tem 3 estágios (limpa
//            filtro → sai da busca → fecha o dialog), tratado no wiring do
//            ChatView (um Esc por clique + re-parse), não aqui.
//   Ctrl+R:  duas telas, conforme o "tui" do settings (sondas history-populated e
//            history-fullscreen, claude 2.1.318, 17 prompts no histórico):
//            - sem fullscreen: linha inline no rodapé, "search prompts: <query>" ou
//              "no matching prompt: <query>"; o match aparece na caixa de input.
//              Ctrl+R cicla para o match anterior; setas não fazem nada. Enter ENVIA
//              o match (vira turno no JSONL); Tab e Esc só preenchem a caixa; Ctrl+C
//              fecha e esvazia a caixa. Sem match, a caixa mantém o match anterior.
//            - fullscreen: modal "Search prompts · everywhere|session|project" com
//              lista (idade + prompt), preview à direita, caixa "⌕" e rodapé
//              "↑/↓ to navigate · Enter to use · Esc to cancel · ctrl+s to scope".
//              Setas navegam (↑ = mais antigo); Ctrl+R não faz nada; Enter e Tab só
//              PREENCHEM a caixa de input; Esc fecha e devolve o rascunho; ctrl+s
//              cicla o escopo e cada abertura volta para "everywhere".
//
// FAIL-CLOSED em tudo: anchors específicos (título exato, footer exato, caixa
// de busca) evitam falso positivo contra texto de conversa comum — mesma
// postura de tui-menu-parser.ts.

export interface TuiModelOption {
  index: number
  label: string
  description?: string
  // Opção marcada com "✔" no buffer — é o modelo/effort ATUALMENTE em uso.
  current: boolean
}

export interface TuiModelMenu {
  kind: 'model'
  options: TuiModelOption[]
  // Índice da opção com o pointer ❯ — é o alvo de ←/→ (effort) e Enter.
  highlightIndex: number
  // Texto da linha de effort sem o marcador nem o hint "←/→ to adjust" (ex.:
  // "High effort (default)", "Medium effort"). Ausente = linha não capturada
  // (fail-soft — CLI mais nova pode ter mudado o layout).
  effortLabel?: string
}

export interface TuiThemeOption {
  index: number
  label: string
  current: boolean
}

export interface TuiThemeMenu {
  kind: 'theme'
  options: TuiThemeOption[]
  highlightIndex: number
  // Bloco de diff/exemplo entre os separadores ╌ (preview do tema destacado).
  preview?: string
  syntaxTheme?: string
  // true = "(ctrl+t to disable)" (preview ligado agora); false = "to enable".
  previewOn: boolean
}

export interface TuiConfigItem {
  label: string
  value: string
  highlighted: boolean
}

export interface TuiConfigMenu {
  kind: 'config'
  tabs: string[]
  // GAP: a aba ativa não é distinguível no texto plano (só cor/negrito, que
  // translateToString não preserva) — sempre a primeira (só "Settings" foi
  // validado tendo conteúdo de qualquer forma). Trocar de aba não é oferecido.
  activeTab: string
  searchQuery: string
  // true = footer de busca ("Type to filter…"); false = footer de lista
  // ("Enter/Space to change…") — é o sinal de foco, não há cursor visível.
  searchFocused: boolean
  items: TuiConfigItem[]
  hasMoreBelow: boolean
}

export interface TuiHistoryResult {
  index: number
  // "28s ago", "3w ago" — como a TUI escreveu.
  age: string
  text: string
}

export interface TuiHistorySearch {
  kind: 'history_search'
  // 'inline' = rodapé "search prompts:"; 'modal' = fullscreen "Search prompts · …".
  mode: 'inline' | 'modal'
  query: string
  // inline: "no matching prompt: …"; modal: lista vazia.
  noMatch: boolean
  // inline: o prompt que a caixa de input mostra para a query (só com query e match).
  match?: string
  // modal: escopo atual, a janela visível da lista e a linha do cursor.
  scope?: string
  results?: TuiHistoryResult[]
  cursorIndex?: number
  moreAbove?: boolean
  moreBelow?: boolean
}

export type TuiPicker = TuiModelMenu | TuiThemeMenu | TuiConfigMenu | TuiHistorySearch

// Linha de opção numerada (mesmo shape do OPTION_RE de tui-menu-parser, mas
// aqui com um split extra pra descrição inline via 2+ espaços — /model e
// /theme desenham a descrição NA MESMA linha, não numa linha wrap abaixo).
const NUMBERED_OPTION_RE = /^\s*(❯)?\s*(\d+)\.\s+(\S.*?)(?:\s{2,}(\S.*))?\s*$/
const CURRENT_MARK_RE = /\s*✔\s*$/

interface ParsedNumberedOption {
  index: number
  label: string
  description?: string
  current: boolean
  highlighted: boolean
}

function parseNumberedOptions(
  lines: string[],
  from: number,
  to: number,
): ParsedNumberedOption[] | null {
  const out: ParsedNumberedOption[] = []
  let expected = 1
  for (let i = from; i < to; i++) {
    const m = NUMBERED_OPTION_RE.exec(lines[i])
    if (!m) continue
    const digit = Number(m[2])
    if (digit !== expected) return null
    expected++
    const current = CURRENT_MARK_RE.test(m[3])
    const label = m[3].replace(CURRENT_MARK_RE, '').trim()
    out.push({
      index: digit - 1,
      label,
      ...(m[4] ? { description: m[4].trim() } : {}),
      current,
      highlighted: m[1] != null,
    })
  }
  return out.length > 0 ? out : null
}

const MODEL_TITLE_RE = /^Select model$/
const MODEL_FOOTER_RE = /Enter to set as default/
const EFFORT_LINE_RE = /^\s*(\S+)\s+(.+?)\s+←\/→ to adjust\s*$/

// Reconhece o picker de /model: título exato + footer exato como anchors
// duplos (evita casar texto de conversa comum que só cite "Select model").
export function parseModelMenu(text: string): TuiModelMenu | null {
  const lines = text.split('\n')
  const titleLine = lines.findIndex((l) => MODEL_TITLE_RE.test(l.trim()))
  if (titleLine < 0) return null
  if (!lines.some((l) => MODEL_FOOTER_RE.test(l))) return null

  const parsed = parseNumberedOptions(lines, titleLine + 1, lines.length)
  if (!parsed) return null

  const highlightIndex = parsed.findIndex((o) => o.highlighted)
  const options: TuiModelOption[] = parsed.map(({ highlighted: _h, ...o }) => o)

  let effortLabel: string | undefined
  for (const l of lines) {
    const m = EFFORT_LINE_RE.exec(l)
    if (m) {
      effortLabel = m[2].trim()
      break
    }
  }

  return {
    kind: 'model',
    options,
    highlightIndex: highlightIndex >= 0 ? highlightIndex : 0,
    ...(effortLabel != null ? { effortLabel } : {}),
  }
}

const THEME_TITLE_RE = /^Theme$/
const THEME_DESC_RE = /^Choose the text style that looks best with your terminal$/
const THEME_FOOTER_RE = /Enter to select/
const DASH_SEPARATOR_RE = /^╌{3,}$/
const SYNTAX_THEME_RE = /^\s*Syntax theme:\s*(.+?)\s*\(ctrl\+t to (disable|enable)\)\s*$/i

// Reconhece o picker de /theme: título + descrição fixa consecutivos (com
// tolerância a linhas em branco entre eles) como anchor duplo.
export function parseThemeMenu(text: string): TuiThemeMenu | null {
  const lines = text.split('\n')
  const titleLine = lines.findIndex((l) => THEME_TITLE_RE.test(l.trim()))
  if (titleLine < 0) return null
  let descLine = -1
  for (let i = titleLine + 1; i < Math.min(lines.length, titleLine + 4); i++) {
    if (THEME_DESC_RE.test(lines[i].trim())) {
      descLine = i
      break
    }
  }
  if (descLine < 0) return null
  if (!lines.some((l) => THEME_FOOTER_RE.test(l))) return null

  const parsed = parseNumberedOptions(lines, descLine + 1, lines.length)
  if (!parsed) return null
  const highlightIndex = parsed.findIndex((o) => o.highlighted)
  const options: TuiThemeOption[] = parsed.map(({ highlighted: _h, description: _d, ...o }) => o)

  const sepLines = lines.reduce<number[]>((acc, l, i) => {
    if (DASH_SEPARATOR_RE.test(l.trim())) acc.push(i)
    return acc
  }, [])
  let preview: string | undefined
  if (sepLines.length >= 2) {
    const inner = lines
      .slice(sepLines[0] + 1, sepLines[1])
      .map((l) => l.trim())
      .filter((l) => l !== '')
    if (inner.length > 0) preview = inner.join('\n')
  }

  let syntaxTheme: string | undefined
  let previewOn = false
  for (const l of lines) {
    const m = SYNTAX_THEME_RE.exec(l)
    if (m) {
      syntaxTheme = m[1].trim()
      previewOn = m[2].toLowerCase() === 'disable'
      break
    }
  }

  return {
    kind: 'theme',
    options,
    highlightIndex: highlightIndex >= 0 ? highlightIndex : 0,
    ...(preview != null ? { preview } : {}),
    ...(syntaxTheme != null ? { syntaxTheme } : {}),
    previewOn,
  }
}

const SEARCH_BOX_RE = /^\s*│\s*⌕\s*(.*?)\s*│\s*$/
const BOX_TOP_RE = /^\s*╭─+╮\s*$/
const BOX_BOTTOM_RE = /^\s*╰─+╯\s*$/
const CONFIG_FOOTER_SEARCH_RE = /Type to filter/
const CONFIG_FOOTER_LIST_RE = /Enter\/Space to change/
const MORE_BELOW_RE = /^\s*[↓↑]\s+\d+\s+more\b/i
const CONFIG_ITEM_RE = /^\s*(❯)?\s*(\S.*?)\s{2,}(\S.*?)\s*$/
const SEARCH_PLACEHOLDER = 'Search settings…'

// Reconhece o picker de /config: a caixa de busca (moldura ╭│╰ + "⌕") é o
// anchor forte (glyph específico do binário, sem chance de aparecer em
// conversa comum) — precisa também de um dos dois footers conhecidos.
export function parseConfigMenu(text: string): TuiConfigMenu | null {
  const lines = text.split('\n')
  let boxTop = -1
  let searchLine = -1
  let boxBottom = -1
  for (let i = 0; i < lines.length; i++) {
    if (SEARCH_BOX_RE.test(lines[i])) {
      searchLine = i
      for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
        if (BOX_TOP_RE.test(lines[j].trim())) {
          boxTop = j
          break
        }
      }
      for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
        if (BOX_BOTTOM_RE.test(lines[j].trim())) {
          boxBottom = j
          break
        }
      }
      break
    }
  }
  if (searchLine < 0 || boxTop < 0 || boxBottom < 0) return null

  const searchFocused = lines.some((l) => CONFIG_FOOTER_SEARCH_RE.test(l))
  const listFocused = lines.some((l) => CONFIG_FOOTER_LIST_RE.test(l))
  if (!searchFocused && !listFocused) return null

  const rawQuery = SEARCH_BOX_RE.exec(lines[searchLine])![1].trim()
  const searchQuery = rawQuery === SEARCH_PLACEHOLDER ? '' : rawQuery

  let tabs: string[] = []
  for (let j = boxTop - 1; j >= 0; j--) {
    const t = lines[j].trim()
    if (t === '') continue
    tabs = t.split(/\s{2,}/).filter(Boolean)
    break
  }

  const items: TuiConfigItem[] = []
  let hasMoreBelow = false
  for (let i = boxBottom + 1; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t === '') continue
    if (CONFIG_FOOTER_SEARCH_RE.test(lines[i]) || CONFIG_FOOTER_LIST_RE.test(lines[i])) break
    if (MORE_BELOW_RE.test(t)) {
      hasMoreBelow = true
      continue
    }
    const m = CONFIG_ITEM_RE.exec(lines[i])
    if (!m) continue
    items.push({ label: m[2].trim(), value: m[3].trim(), highlighted: m[1] != null })
  }
  if (items.length === 0) return null

  return {
    kind: 'config',
    tabs,
    activeTab: tabs[0] ?? '',
    searchQuery,
    searchFocused,
    items,
    hasMoreBelow,
  }
}

// Linha inline do rodapé/status bar — NUNCA uma caixa. Captura a query até o
// próximo run de 2+ espaços (padding antes do indicador de modo de permissão)
// ou o fim da linha.
const HISTORY_RE = /(no matching prompt|search prompts): (.*?)(?: {2,}|$)/
const RULE_LINE_RE = /^─{10,}$/
const INPUT_HEAD_RE = /^❯[\s\u00a0]?/

// Caixa de input logo acima da linha da busca: régua, "❯ texto" (com NBSP), régua.
function inputBoxAbove(lines: string[], footer: number): string | null {
  if (footer < 1 || !RULE_LINE_RE.test(lines[footer - 1].trim())) return null
  const rows: string[] = []
  for (let i = footer - 2; i >= 0 && i >= footer - 12; i--) {
    const t = lines[i].trim()
    if (RULE_LINE_RE.test(t)) {
      rows.reverse()
      if (rows.length === 0 || !INPUT_HEAD_RE.test(rows[0])) return null
      rows[0] = rows[0].replace(INPUT_HEAD_RE, '')
      return rows.join('\n').replace(/\u00a0/g, ' ').trim()
    }
    rows.push(t)
  }
  return null
}

export function parseHistorySearch(text: string): TuiHistorySearch | null {
  return parseHistoryModal(text) ?? parseHistoryInline(text)
}

function parseHistoryInline(text: string): TuiHistorySearch | null {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = HISTORY_RE.exec(lines[i])
    if (!m) continue
    const query = m[2].trim()
    const noMatch = m[1] === 'no matching prompt'
    // Sem query a caixa mostra o rascunho; sem match, o match anterior (velho).
    const match = query !== '' && !noMatch ? inputBoxAbove(lines, i) : null
    return { kind: 'history_search', mode: 'inline', query, noMatch, ...(match ? { match } : {}) }
  }
  return null
}

const MODAL_TITLE_RE = /^Search prompts · (\S+)$/
const MODAL_FOOTER_RE = /↑\/↓ to navigate · Enter to use · Esc to cancel/
const MODAL_FILTER_RE = /^│\s*⌕\s*(.*?)\s*│$/
const MODAL_PLACEHOLDER = 'Filter history…'
const MODAL_ROW_RE = /^(❯)?\s*([↑↓])?\s*(\d+(?:s|m|h|d|w|mo|y) ago)\s+(\S.*)$/
// Coluna do preview à direita da lista: começa no 1º caractere de moldura depois de 2+ espaços.
const PREVIEW_SPLIT_RE = /\s{2,}[╭│╰]/

function parseHistoryModal(text: string): TuiHistorySearch | null {
  const lines = text.split('\n')
  const footer = lines.findIndex((l) => MODAL_FOOTER_RE.test(l))
  if (footer < 0) return null
  let title = -1
  for (let i = footer - 1; i >= 0 && i >= footer - 40; i--) {
    if (MODAL_TITLE_RE.test(lines[i].trim())) {
      title = i
      break
    }
  }
  if (title < 0) return null
  const filterLine = lines.slice(title + 1, footer).findIndex((l) => MODAL_FILTER_RE.test(l.trim()))
  if (filterLine < 0) return null
  const rawQuery = MODAL_FILTER_RE.exec(lines[title + 1 + filterLine].trim())![1]
  const results: TuiHistoryResult[] = []
  let cursorIndex: number | undefined
  let moreAbove = false
  let moreBelow = false
  for (let i = title + 1; i < title + 1 + filterLine; i++) {
    const t = lines[i].trim()
    const split = t.search(PREVIEW_SPLIT_RE)
    const listPart = split >= 0 ? t.slice(0, split) : t
    const m = MODAL_ROW_RE.exec(listPart)
    if (!m) continue
    if (m[1]) cursorIndex = results.length
    if (m[2] === '↑') moreAbove = true
    if (m[2] === '↓') moreBelow = true
    results.push({ index: results.length, age: m[3], text: m[4].trim() })
  }
  return {
    kind: 'history_search',
    mode: 'modal',
    scope: MODAL_TITLE_RE.exec(lines[title].trim())![1],
    query: rawQuery === MODAL_PLACEHOLDER ? '' : rawQuery,
    noMatch: results.length === 0,
    results,
    ...(cursorIndex != null ? { cursorIndex } : {}),
    ...(moreAbove ? { moreAbove } : {}),
    ...(moreBelow ? { moreBelow } : {}),
  }
}

// Combinador fail-closed: tenta cada parser específico (anchors mutuamente
// exclusivos — nunca dois batem no mesmo buffer) e devolve o primeiro match.
export function parseTuiPicker(text: string): TuiPicker | null {
  return (
    parseModelMenu(text) ?? parseThemeMenu(text) ?? parseConfigMenu(text) ?? parseHistorySearch(text)
  )
}

// Identidade estável pro guard de clique (mesmo papel de menuFingerprint em
// tui-menu-parser.ts): re-parse fresco divergente do picker clicado → não
// digitar nada no PTY.
export function pickerFingerprint(picker: TuiPicker): string {
  switch (picker.kind) {
    case 'model':
      return [
        'model',
        picker.highlightIndex,
        picker.effortLabel ?? '',
        ...picker.options.map((o) => `${o.index}:${o.label}:${o.current}`),
      ].join('\n')
    case 'theme':
      return [
        'theme',
        picker.highlightIndex,
        picker.previewOn,
        ...picker.options.map((o) => `${o.index}:${o.label}:${o.current}`),
      ].join('\n')
    case 'config':
      return [
        'config',
        picker.activeTab,
        picker.searchQuery,
        picker.searchFocused,
        ...picker.items.map((i) => `${i.label}:${i.value}:${i.highlighted}`),
      ].join('\n')
    case 'history_search':
      return [
        'history_search',
        picker.mode,
        picker.query,
        picker.noMatch,
        picker.match ?? '',
        picker.scope ?? '',
        picker.cursorIndex ?? '',
        ...(picker.results ?? []).map((r) => r.text),
      ].join('\n')
  }
}
