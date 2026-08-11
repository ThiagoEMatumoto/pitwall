import type { ChatMessage, ChatQuestion } from '../../../shared/types/chat'

// Subconjunto relevante de uma linha do transcript JSONL do Claude Code. Mantemos
// um shape LOCAL (sem importar os internos do metrics-service/session-activity)
// porque este é o contrato cru em disco — o mesmo que aqueles módulos leem cada um
// pro seu fim. Acoplar os três parsers não compraria nada e amarraria evoluções.
interface RawContentItem {
  type?: string
  text?: string
  // bloco de raciocínio (extended thinking); redacted_thinking não traz texto.
  thinking?: string
  // tool_use (assistant)
  id?: string
  name?: string
  input?: unknown
  // tool_result (user)
  tool_use_id?: string
  content?: string | RawContentItem[]
  is_error?: boolean
}

interface RawLine {
  type?: string
  // Turnos de subagente (Task) vivem inline com isSidechain:true.
  isSidechain?: boolean
  // Conteúdo injetado pela CLI no turno do usuário (SKILL.md, caveats, avisos) —
  // o humano NÃO digitou isso. Nunca pode virar bolha de usuário.
  isMeta?: boolean
  // Resumo do /compact gravado como turno type:'user'. text vem em
  // message.content (string) — o humano nunca digitou isso.
  isCompactSummary?: boolean
  // Linhas type:'system': metadados de nível de linha (sem `message`). subtype
  // classifica; content/error trazem o texto; level a severidade.
  subtype?: string
  content?: string
  level?: string
  error?: unknown
  // Presente só em subtype:'compact_boundary'. trigger: 'manual'|'auto'.
  compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number }
  message?: {
    // id da mensagem da API. Linhas assistant de um mesmo turno de streaming
    // compartilham o id — base do agrupamento de blocos text adjacentes.
    id?: string
    role?: string
    content?: string | RawContentItem[]
    // Só em linhas assistant. '<synthetic>' marca turnos sem modelo real
    // (ex.: sumarização interna) — ignorado na detecção de troca de modelo.
    model?: string
  }
  // Campo IRMÃO de `message` (nível da linha, não do content). A CLI grava aqui o
  // resultado estruturado do tool_use que a linha responde: `answers` (mapa
  // pergunta→opção) pro AskUserQuestion, `plan`/`filePath` pro ExitPlanMode, e
  // `interrupted:true` quando a ferramenta foi abortada no meio (saída parcial).
  toolUseResult?: unknown
  // message.id do turno de assistant que o Ctrl+C do usuário cortou. Gravado na
  // MESMA linha que traz o texto "[Request interrupted by user…]" (validado
  // contra transcripts reais: casa sempre com um message.id de assistant).
  interruptedMessageId?: string
}

// A CLI marca `toolUseResult.interrupted` quando a ferramenta foi abortada no
// meio — o content do tool_result é saída PARCIAL. Só o boolean exato conta.
function isInterruptedResult(toolUseResult: unknown): boolean {
  if (!toolUseResult || typeof toolUseResult !== 'object') return false
  return (toolUseResult as { interrupted?: unknown }).interrupted === true
}

// AskUserQuestion: input.questions[] = { question, header, multiSelect, options:[{label,description}] }.
function parseQuestions(input: unknown): ChatQuestion[] {
  if (!input || typeof input !== 'object') return []
  const qs = (input as { questions?: unknown }).questions
  if (!Array.isArray(qs)) return []
  return qs.map((q) => {
    const o = (q ?? {}) as Record<string, unknown>
    const options = Array.isArray(o.options)
      ? o.options.map((opt) => {
          const oo = (opt ?? {}) as Record<string, unknown>
          return {
            label: typeof oo.label === 'string' ? oo.label : '',
            description: typeof oo.description === 'string' ? oo.description : '',
          }
        })
      : []
    return {
      question: typeof o.question === 'string' ? o.question : '',
      header: typeof o.header === 'string' ? o.header : '',
      multiSelect: o.multiSelect === true,
      options,
    }
  })
}

// ExitPlanMode: input.plan (markdown) + input.planFilePath (caminho do arquivo
// de plano em ~/.claude/plans, ausente em CLIs antigos) + input.allowedPrompts.
function parsePlan(input: unknown): {
  plan: string
  planFilePath: string | null
  allowedPrompts: string[] | null
} {
  const o = (input ?? {}) as Record<string, unknown>
  const ap = o.allowedPrompts
  return {
    plan: typeof o.plan === 'string' ? o.plan : '',
    planFilePath: typeof o.planFilePath === 'string' ? o.planFilePath : null,
    allowedPrompts: Array.isArray(ap) ? ap.filter((p): p is string => typeof p === 'string') : null,
  }
}

// PURO: último tool_use Write/Edit do transcript cujo alvo é um arquivo de plano
// (~/.claude/plans/*.md). O plan file é escrito DURANTE o plan mode — este path
// permite resolver o conteúdo do plano ANTES da aprovação, já que o tool_use
// pendente do ExitPlanMode não é gravado no JSONL.
const PLAN_FILE_RE = /\/\.claude\/plans\/[^/]+\.md$/
export function lastPlanFilePath(messages: ChatMessage[]): string | null {
  let last: string | null = null
  for (const m of messages) {
    if (m.kind !== 'tool_use') continue
    if (m.name !== 'Write' && m.name !== 'Edit') continue
    const fp = (m.input as { file_path?: unknown } | null | undefined)?.file_path
    if (typeof fp === 'string' && PLAN_FILE_RE.test(fp)) last = fp
  }
  return last
}

// Mapa pergunta→opção(ões) escolhida(s) do toolUseResult de um AskUserQuestion.
function parseAnswers(tur: unknown): Record<string, string> {
  if (!tur || typeof tur !== 'object') return {}
  const ans = (tur as { answers?: unknown }).answers
  if (!ans || typeof ans !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(ans as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

// Dados de um subagente associados à sua invocação (Task/Agent), por toolUseId.
// Montados no service a partir dos arquivos agent-*.meta.json/.jsonl e injetados
// no parser pra virar o kind 'subagent' no lugar do tool_use genérico.
export interface SubagentInfo {
  name: string
  description: string
  turnCount: number
  turns: string[]
}

// Resumo de um turno de subagente: junta os blocos de texto do assistant; se não
// houver texto (turno só de tool_use), lista os nomes das ferramentas. Trunca pra
// não inchar o payload do IPC (a UI mostra o snippet, expansível sob demanda).
function summarizeAssistantTurn(content: string | RawContentItem[] | undefined): string {
  const truncate = (s: string, max = 280): string => {
    const t = s.replace(/\s+/g, ' ').trim()
    return t.length > max ? t.slice(0, max) + '…' : t
  }
  if (typeof content === 'string') return truncate(content)
  if (!Array.isArray(content)) return ''
  const text = content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
    .trim()
  if (text) return truncate(text)
  const tools = content
    .filter((c) => c?.type === 'tool_use' && typeof c.name === 'string')
    .map((c) => c.name as string)
  return tools.length ? `⚙ ${tools.join(', ')}` : ''
}

// PURO: conteúdo de um agent-<hash>.jsonl → contagem de turnos + resumos. Cada
// linha type==='assistant' é um turno do subagente (todas isSidechain). Tolerante a
// linha malformada (pula a linha, nunca o arquivo).
export function parseSubagentTurns(jsonl: string): { turnCount: number; turns: string[] } {
  let turnCount = 0
  const turns: string[] = []
  for (const raw of jsonl.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let obj: RawLine
    try {
      obj = JSON.parse(line) as RawLine
    } catch {
      continue
    }
    if (obj.type !== 'assistant') continue
    turnCount += 1
    const text = summarizeAssistantTurn(obj.message?.content)
    if (text) turns.push(text)
  }
  return { turnCount, turns }
}

// Subtypes de linha type:'system' que VALEM mostrar no chat (curadoria). O resto
// (stop_hook_summary, turn_duration, scheduled_task_fire, away_summary, …) é
// telemetria/ruído de alto volume e fica de fora — nada de despejar cru.
const SYSTEM_LABELS: Record<string, string> = {
  compact_boundary: 'Conversa compactada',
  api_error: 'Erro de API',
  informational: 'Sistema',
}

function asLevel(v: unknown): 'info' | 'warning' | 'error' {
  return v === 'warning' || v === 'error' ? v : 'info'
}

// PURO: linha system → chip curado, ou null se for um subtype não-whitelistado.
// label = texto curto do chip (sempre visível); detail = conteúdo expandido.
// compact_boundary carrega trigger/preTokens/postTokens quando o transcript
// grava compactMetadata (CLIs antigas não gravam — campos ficam undefined).
function parseSystemLine(obj: RawLine): {
  label: string
  detail: string
  level: 'info' | 'warning' | 'error'
  trigger?: string
  preTokens?: number
  postTokens?: number
} | null {
  const sub = obj.subtype
  if (!sub || !(sub in SYSTEM_LABELS)) return null
  const label = SYSTEM_LABELS[sub]
  const content = typeof obj.content === 'string' ? obj.content : ''
  if (sub === 'api_error') {
    const detail = typeof obj.error === 'string' ? obj.error : content || JSON.stringify(obj.error ?? '')
    return { label, detail, level: 'error' }
  }
  if (sub === 'compact_boundary' && obj.compactMetadata) {
    const cm = obj.compactMetadata
    return {
      label,
      detail: content || label,
      level: asLevel(obj.level),
      trigger: typeof cm.trigger === 'string' ? cm.trigger : undefined,
      preTokens: typeof cm.preTokens === 'number' ? cm.preTokens : undefined,
      postTokens: typeof cm.postTokens === 'number' ? cm.postTokens : undefined,
    }
  }
  return { label, detail: content || label, level: asLevel(obj.level) }
}

// Slash command embutido em content (<command-name>/<command-args>), presente
// tanto no formato atual (content string de type:'user') quanto no antigo
// (type:'system'/local_command). name normalizado SEM a barra.
function parseCommandTag(text: string): { name: string; args: string } | null {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim()
  if (!name) return null
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? ''
  return { name: name.replace(/^\//, ''), args }
}

// Saída de comando local (<local-command-stdout>), com ANSI removido. null quando
// a tag não existe OU a saída é vazia (comando mudo não gera chip).
function parseStdoutTag(text: string): string | null {
  const inner = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text)?.[1]
  if (inner == null) return null
  const clean = stripAnsi(inner).trim()
  return clean || null
}

// Remove escapes ANSI (CSI: cores/estilos; OSC: títulos/hyperlinks) da saída de
// comandos locais. Helper local de propósito — strip-ansi não é dependência do
// projeto e uma regex cobre o que a CLI grava.
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

// Rótulo curto pra um chip de meta: primeira linha não-vazia, sem marcadores de
// heading/tag, truncada — o conteúdo integral fica na expansão.
function metaLabel(text: string): string {
  const first =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? ''
  const clean = first.replace(/^#{1,6}\s+/, '').replace(/^<[^>]*>\s*/, '').trim()
  const label = clean || 'conteúdo'
  return label.length > 80 ? label.slice(0, 80) + '…' : label
}

// PURO: classifica uma STRING gravada como turno de usuário. A CLI grava como
// type:'user' muita coisa que o humano não digitou (skills injetadas, slash
// commands, stdout de comando, avisos) — a ordem abaixo é FAIL-SAFE: só string
// sem nenhum marker conhecido vira bolha 'user'.
export function classifyUserString(obj: RawLine, text: string): ChatMessage {
  // Resumo do /compact: SEMPRE prioritário — o marker vem direto da CLI, não
  // precisa (nem deve) passar pelas heurísticas de texto abaixo.
  if (obj.isCompactSummary === true) return { kind: 'compact_summary', text }
  if (obj.isMeta === true) return { kind: 'meta', text, label: metaLabel(text) }
  if (text.includes('<command-name>')) {
    const cmd = parseCommandTag(text)
    if (cmd) return { kind: 'command', ...cmd }
    return { kind: 'meta', text, label: metaLabel(text) }
  }
  if (text.includes('<local-command-stdout>')) {
    return { kind: 'command_output', text: parseStdoutTag(text) ?? '' }
  }
  if (text.includes('<local-command-caveat>')) {
    return { kind: 'meta', text, label: metaLabel(text) }
  }
  if (text.includes('<task-notification>')) {
    return { kind: 'system', label: 'Tarefa em background', detail: text, level: 'info' }
  }
  if (text.trimStart().startsWith('[Request interrupted')) {
    // 'warning', não 'info': um cancelamento muda o que aconteceu de fato na
    // sessão (o turno não terminou) — precisa ser visível, não um chip cinza.
    return { kind: 'system', label: 'Interrompido pelo usuário', detail: '', level: 'warning' }
  }
  if (text.trimStart().startsWith('<system-reminder>')) {
    return { kind: 'meta', text, label: metaLabel(text) }
  }
  return { kind: 'user', text }
}

// Normaliza o content de um tool_result para string: a CLI grava ou uma string
// crua ou um array de blocos { type:'text', text }. Junta os blocos de texto;
// ignora blocos não-textuais (ex.: imagens), que a F5b trataria à parte.
function toText(content: string | RawContentItem[] | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
}

// PURO: JSONL inteiro → lista ordenada de mensagens de chat. Tolerante a linha
// malformada (try/catch por linha, pula) — a última linha pode estar partida por
// escrita parcial durante o streaming. Linhas que não são user/assistant
// (ai-title, custom-title, queue-operation, attachment, summary, etc.) e turnos de
// subagente (isSidechain) são ignorados: o chat renderiza a conversa principal.
//
// Momentos interativos do claude ganham kinds próprios (não caem como tool_use/
// tool_result genéricos): AskUserQuestion → ask_user_question (+ ..._answered) e
// ExitPlanMode → exit_plan_mode (+ plan_decision). O tool_use vem antes do seu
// tool_result no transcript, então linkamos por id via os Sets abaixo.
//
// Subagentes (Task/Agent): quando `subagents` traz dados para o id do tool_use, ele
// vira o kind 'subagent' (nome + descrição + turnos) no lugar do tool_use genérico.
// Sem dados (map ausente/miss), permanece tool_use — degrada sem quebrar.
//
// LIMITAÇÃO: prompts de permissão de tool (y/n de Edit/Bash) são TTY-only e NÃO
// vão pro JSONL — o chat não os mostra a partir do transcript (fallback: terminal).
export function parseChatMessages(
  jsonl: string,
  subagents?: Map<string, SubagentInfo>,
): ChatMessage[] {
  const out: ChatMessage[] = []
  // Ids de tool_use interativos já vistos, pra classificar o tool_result seguinte.
  const askIds = new Set<string>()
  const planIds = new Set<string>()
  // Ids de tool_use que viraram subagente, pra dobrar o status (is_error) do
  // tool_result no card em vez de mostrar um tool_result genérico duplicado.
  const subIds = new Set<string>()
  // Agrupamento de assistant: blocos text ADJACENTES do mesmo message.id fundem
  // numa única mensagem (um turno de streaming vira várias linhas JSONL com o
  // mesmo id). QUALQUER outro push (tool_use, thinking, user, …) quebra a
  // adjacência — o interleaving texto→tool→texto é preservado.
  let lastAssistantMergeId: string | null = null
  // Último modelo real (não-'<synthetic>') visto numa linha assistant. null até
  // a 1ª ocorrência — a 1ª nunca gera marcador, só define o baseline.
  let lastModel: string | null = null
  // Rastreio da INTERRUPÇÃO (Ctrl+C). A linha que traz "[Request interrupted…]"
  // carrega `interruptedMessageId` = o message.id do turno de assistant cortado;
  // guardamos os ÍNDICES em `out` por message.id pra marcar, no fim do parse, o
  // que ficou pela metade. Índices (não referências) porque o merge de texto
  // adjacente substitui o objeto na mesma posição.
  const assistantIdxByMsgId = new Map<string, number[]>()
  const toolUseIdxByMsgId = new Map<string, { idx: number; id: string }[]>()
  const resolvedToolIds = new Set<string>()
  const interruptedMsgIds = new Set<string>()
  const trackIdx = <T,>(map: Map<string, T[]>, key: string, value: T): void => {
    const list = map.get(key)
    if (list) list.push(value)
    else map.set(key, [value])
  }
  const push = (msg: ChatMessage): void => {
    lastAssistantMergeId = null
    out.push(msg)
  }
  const pushAssistantText = (text: string, msgId: string | null): void => {
    const last = out[out.length - 1]
    if (msgId !== null && msgId === lastAssistantMergeId && last?.kind === 'assistant') {
      out[out.length - 1] = { kind: 'assistant', text: last.text + '\n\n' + text }
    } else {
      out.push({ kind: 'assistant', text })
      if (msgId !== null) trackIdx(assistantIdxByMsgId, msgId, out.length - 1)
    }
    lastAssistantMergeId = msgId
  }
  // Classificação fail-safe + filtro de saída vazia (comando sem stdout não gera chip).
  const pushUserText = (obj: RawLine, text: string): void => {
    const msg = classifyUserString(obj, text)
    if (msg.kind === 'command_output' && !msg.text) return
    push(msg)
  }
  for (const raw of jsonl.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let obj: RawLine
    try {
      obj = JSON.parse(line) as RawLine
    } catch {
      continue // malformada / escrita parcial — pula a linha, nunca o arquivo.
    }
    if (obj.isSidechain === true) continue
    if (typeof obj.interruptedMessageId === 'string' && obj.interruptedMessageId)
      interruptedMsgIds.add(obj.interruptedMessageId)
    if (obj.type === 'system') {
      // Formato ANTIGO de slash command (type:'system'/local_command): emite os
      // MESMOS kinds command/command_output do formato atual — visual unificado.
      if (obj.subtype === 'local_command') {
        const content = typeof obj.content === 'string' ? obj.content : ''
        const cmd = parseCommandTag(content)
        if (cmd) push({ kind: 'command', ...cmd })
        const stdout = parseStdoutTag(content)
        if (stdout) push({ kind: 'command_output', text: stdout })
        continue
      }
      const sys = parseSystemLine(obj)
      if (sys) push({ kind: 'system', ...sys })
      continue
    }
    if (obj.type !== 'user' && obj.type !== 'assistant') continue

    const content = obj.message?.content

    if (obj.type === 'user') {
      if (typeof content === 'string') {
        if (content.trim()) pushUserText(obj, content)
        continue
      }
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item?.type === 'tool_result') {
            const forId = typeof item.tool_use_id === 'string' ? item.tool_use_id : ''
            if (askIds.has(forId)) {
              push({
                kind: 'ask_user_question_answered',
                forId,
                answers: parseAnswers(obj.toolUseResult),
              })
            } else if (subIds.has(forId)) {
              push({ kind: 'subagent_result', forId, isError: item.is_error === true })
            } else if (planIds.has(forId)) {
              // Aprovação tem texto canônico "User has approved your plan."; a
              // ausência dele (rejeição/feedback) marca não-aprovado.
              push({
                kind: 'plan_decision',
                forId,
                approved: /User has approved/i.test(toText(item.content)),
              })
            } else {
              push({
                kind: 'tool_result',
                forId,
                content: toText(item.content),
                isError: item.is_error === true,
                ...(isInterruptedResult(obj.toolUseResult) ? { interrupted: true } : {}),
              })
            }
            if (forId) resolvedToolIds.add(forId)
          } else if (item?.type === 'text' && typeof item.text === 'string') {
            // Mesma classificação fail-safe: text blocks junto de tool_results
            // costumam ser system-reminders/contexto de hook, não o humano.
            if (item.text.trim()) pushUserText(obj, item.text)
          }
        }
      }
      continue
    }

    // assistant
    const msgId = typeof obj.message?.id === 'string' ? obj.message.id : null
    // Troca de modelo mid-session: emite o marcador ANTES do conteúdo deste
    // turno. '<synthetic>' (turnos sem modelo real) é ignorado por completo —
    // não conta como troca nem vira o novo baseline.
    const model = typeof obj.message?.model === 'string' ? obj.message.model : null
    if (model && model !== '<synthetic>') {
      if (lastModel !== null && model !== lastModel) {
        push({ kind: 'model_change', from: lastModel, to: model })
      }
      lastModel = model
    }
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item?.type === 'text' && typeof item.text === 'string') {
          if (item.text.trim()) pushAssistantText(item.text, msgId)
        } else if (item?.type === 'thinking') {
          // Blocos de thinking costumam vir vazios (só assinatura) quando o modelo
          // não expõe o raciocínio — só emitimos quando há texto de fato.
          const t = typeof item.thinking === 'string' ? item.thinking.trim() : ''
          if (t) push({ kind: 'thinking', text: t })
        } else if (item?.type === 'redacted_thinking') {
          push({ kind: 'thinking', text: '(raciocínio oculto)' })
        } else if (item?.type === 'tool_use' && typeof item.name === 'string') {
          const id = typeof item.id === 'string' ? item.id : ''
          const sub = id ? subagents?.get(id) : undefined
          if (sub) {
            if (id) subIds.add(id)
            push({
              kind: 'subagent',
              id,
              name: sub.name,
              description: sub.description,
              turnCount: sub.turnCount,
              turns: sub.turns,
            })
          } else if (item.name === 'AskUserQuestion') {
            if (id) askIds.add(id)
            push({ kind: 'ask_user_question', id, questions: parseQuestions(item.input) })
          } else if (item.name === 'ExitPlanMode') {
            if (id) planIds.add(id)
            push({ kind: 'exit_plan_mode', id, ...parsePlan(item.input) })
          } else {
            push({ kind: 'tool_use', id, name: item.name, input: item.input })
            if (msgId !== null && id) trackIdx(toolUseIdxByMsgId, msgId, { idx: out.length - 1, id })
          }
        }
      }
    } else if (typeof content === 'string' && content.trim()) {
      pushAssistantText(content, msgId)
    }
  }
  // Passo final da interrupção: só aqui sabemos quais tool_use ficaram órfãos (o
  // tool_result vem depois no arquivo) e quais turnos foram cortados. Marcar o
  // texto do assistant importa tanto quanto o tool_use — no dado real a maioria
  // dos Ctrl+C corta o assistant no meio da resposta, não uma ferramenta.
  for (const msgId of interruptedMsgIds) {
    for (const idx of assistantIdxByMsgId.get(msgId) ?? []) {
      const msg = out[idx]
      if (msg?.kind === 'assistant') out[idx] = { ...msg, interrupted: true }
    }
    for (const { idx, id } of toolUseIdxByMsgId.get(msgId) ?? []) {
      if (resolvedToolIds.has(id)) continue
      const msg = out[idx]
      if (msg?.kind === 'tool_use') out[idx] = { ...msg, interrupted: true }
    }
  }
  return out
}
