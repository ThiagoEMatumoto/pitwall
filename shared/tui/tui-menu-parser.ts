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
// Menu de plano: "Would you like to proceed?" / "Exit plan mode?" com opções
// "Yes, auto-accept edits" / "Yes, manually approve edits" / "No, keep planning"
// (contagem VARIÁVEL entre versões).
//
// Prompts TTY-only (NUNCA vão pro JSONL, nem depois da resposta): permissão de
// tool ("Do you want to …?" + opções Yes/No) e trust de diretório ("Only proceed
// if you trust this configuration." + "Yes, I trust this folder" etc.). Mesmo
// shape numerado; classificados como kind 'permission'/'trust', com o box acima
// da pergunta (diff/comando) capturado em `context`.
//
// FAIL-CLOSED em tudo: qualquer dúvida no parse → null (a UI degrada pro banner
// "responda no terminal"). Nunca renderizar clique sobre um parse incerto.

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
}

// Uma aba da barra de abas (multi-pergunta/multi-select): "←  ☒ Rótulo  ☐
// Rótulo  ✔ Submit  →" — validado ao vivo contra claude 2.1.215. `done` reflete
// o glyph ☒ (alguma seleção feita nessa pergunta) vs ☐ (nada marcado ainda); a
// aba "Submit" sempre chega com done:true (glyph ✔), mas não é usada pra lógica.
export interface TuiMenuTab {
  label: string
  done: boolean
}

export interface TuiMenu {
  kind: 'question' | 'plan' | 'permission' | 'trust' | 'question_review'
  question?: string
  // permission/trust: linhas do box ACIMA da pergunta (diff/comando/config).
  // question_review: resumo "pergunta → resposta" da tela de revisão.
  // Aparadas de bordas de box-drawing. Fail-soft: se nada legível sobrar, ausente.
  context?: string
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
const SEPARATOR_RE = /^─{3,}$/
// "Chat about this" às vezes perde o número quando o menu tem preview/notes
// (artefato de layout observado ao vivo — o box de preview desloca a
// numeração) — tolerado sem dígito na zona pós-última-opção; não é clicável
// de qualquer forma (sentinela 'chat' já é filtrado no wiring).
const UNNUMBERED_SENTINEL_RE = /^(Type something\.?|Chat about this\.?)$/
// Chip/header truncado acima da pergunta (campo `header` da tool AskUserQuestion,
// prefixado por um glyph de checkbox — observado ao vivo no 2.1.216, sonda
// Fase 0). Nunca faz parte do texto da pergunta — é um rótulo curto à parte.
const CHIP_RE = /^☐\s+\S/
// Prompt de permissão de tool (y/n): headings "Do you want to make this edit to
// …" / "Do you want to proceed?" / "run this command unsandboxed" etc. — todos
// casam o genérico /Do you want/. Opções com strings exatas do binário 2.1.212.
const PERMISSION_QUESTION_RE = /Do you want/i
const PERMISSION_OPTION_RE = /don't ask again|allow all edits|No, and tell Claude/i
// Trust prompt de diretório: heading real é "Only proceed if you trust this
// configuration." (+ "This folder adds …"); opções exatas do binário.
const TRUST_HEADING_RE = /trust this configuration|trust this folder/i
const TRUST_OPTION_RE = /I trust this folder|remember this directory|No, continue without these permissions/i
// Classificação do menu de plano (labels exatos vistos no binário da CLI).
const PLAN_QUESTION_RE = /Would you like to proceed|Exit plan mode/i
const PLAN_OPTION_RE = /^Yes, auto-accept edits|^Yes, manually approve|^No, keep planning/i

// Bordas de box-drawing (moldura do box de diff/comando) aparadas do contexto.
const BOX_EDGE_RE = /^[\s│╭╮╰╯─]+|[\s│╭╮╰╯─]+$/g

// Bloco de contexto do prompt de permissão/trust: linhas ACIMA da pergunta (o
// box com o diff/comando/config que o usuário está aprovando). Sobe no máximo
// `max` linhas e para na borda superior do box (╭). Fail-soft: pode vir vazio.
function extractContext(lines: string[], questionLine: number, max = 15): string | undefined {
  const parts: string[] = []
  for (let i = questionLine - 1; i >= 0 && i >= questionLine - max; i--) {
    const raw = lines[i]
    const cleaned = raw.replace(BOX_EDGE_RE, '')
    if (cleaned !== '') parts.unshift(cleaned)
    if (raw.includes('╭')) break // topo do box — acima é conversa antiga
  }
  return parts.length > 0 ? parts.join('\n') : undefined
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
}

function scanBetween(lines: string[], from: number, to: number): ScanResult {
  const descParts: string[] = []
  const previewParts: string[] = []
  let hasNotesHint = false
  for (let i = from; i < to; i++) {
    const raw = lines[i]
    const t = raw.trim()
    if (t === '') continue
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
  return { descParts, previewParts, hasNotesHint }
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
const BOX_DRAWING_RE = /[┌┐└┘│╭╮╰╯─]/
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
    return null
  }

  // Linhas não-numeradas ENTRE opções = descrição da opção anterior OU
  // conteúdo de preview/notas — nunca os dois misturados.
  let previewParts: string[] = []
  let hasNotesHint = false
  const options: TuiMenuOption[] = run.map((entry, k) => {
    const next = k + 1 < run.length ? run[k + 1].line : last.line + 1
    const scanned = scanBetween(lines, entry.line + 1, next)
    previewParts = previewParts.concat(scanned.previewParts)
    hasNotesHint = hasNotesHint || scanned.hasNotesHint

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
  const context =
    kind === 'permission' || kind === 'trust'
      ? extractContext(lines, questionLine)
      : kind === 'question_review'
        ? extractReviewSummary(lines, questionLine)
        : undefined

  const tabs = kind === 'question' ? extractTabBar(lines, questionLine) : undefined
  const multiSelect = MULTI_SELECT_RE.test(text) || options.some((o) => o.checked != null)
  // Preview/notas presente → dígito só navega/toggla, precisa de Enter
  // separado pra submeter (regra validada na Fase 0).
  const submitOnDigit = previewParts.length === 0 && !hasNotesHint

  return {
    kind,
    ...(kind === 'question_review' ? { question: 'Review your answers' } : question != null ? { question } : {}),
    ...(context != null ? { context } : {}),
    options,
    multiSelect,
    ...(tabs != null ? { tabs } : {}),
    submitOnDigit,
  }
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

// Identidade estável de um menu parseado (pergunta + labels na ordem). Usada pra:
// (a) não re-renderizar quando o re-parse produz o mesmo menu; (b) guard de
// clique — re-parse fresco divergente do menu clicado → NÃO digitar no PTY.
export function menuFingerprint(menu: TuiMenu): string {
  return [
    menu.kind,
    menu.multiSelect ? 'multi' : 'single',
    menu.question ?? '',
    ...(menu.tabs?.map((t) => `tab:${t.label}:${t.done}`) ?? []),
    ...menu.options.map((o) => `${o.index}:${o.label}:${o.checked ?? ''}`),
    // \n como separador: nenhum campo pode conter quebra (todos vêm de split('\n')).
  ].join('\n')
}
