// Distilação pura do transcript + prompts da síntese de features. SEM deps de
// electron/db, para ser testável isoladamente (mesmo padrão de feature-heuristics.ts).
import { readFileSync } from 'node:fs'
import matter from 'gray-matter'
import type { Feature } from '../../../shared/types/ipc'
import type { SessionRecord } from './feature-store'
import { pickWorkBranch } from './feature-heuristics'

// Stage 1 destila o digest, então pode ser generoso — capturamos mais sinal e
// deixamos a LLM resumir.
const MAX_USER_PROMPT_CHARS = 800
const MAX_ASSISTANT_TEXT_CHARS = 600
const MAX_FINAL_SUMMARY_CHARS = 2_000
const MAX_DIGEST_ENTRIES = 60
const MAX_TODOS = 30
const MAX_BASH_CMDS = 30

interface ContentItem {
  type?: string
  text?: string
  name?: string
  input?: {
    file_path?: string
    path?: string
    command?: string
    todos?: Array<{ content?: string; status?: string }>
  }
}

interface TranscriptLine {
  type?: string
  gitBranch?: string
  message?: {
    role?: string
    content?: ContentItem[] | string
  }
}

export interface Digest {
  userPrompts: string[]
  assistantNotes: string[]
  // Última mensagem de texto do assistant — costuma ser o resumo da sessão.
  finalSummary: string | null
  // Snapshot mais recente do TodoWrite (tarefas + status).
  todos: string[]
  filesTouched: string[]
  // Contagem de uso por ferramenta (Edit/Write/Bash/...) — sinal de "o que foi feito".
  toolRollup: Record<string, number>
  bashCommands: string[]
  gitBranch: string | null
  refs: string[] // PR/commit citados
  userTurns: number
  editCount: number
}

const PR_RE = /\b(?:PR\s*#?\d+|#\d+|\b[0-9a-f]{7,40}\b)/gi

export function parseTranscript(path: string): TranscriptLine[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return parseTranscriptText(raw)
}

// Separado pra testar sem tocar o filesystem.
export function parseTranscriptText(raw: string): TranscriptLine[] {
  const out: TranscriptLine[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t) as TranscriptLine)
    } catch {
      // linha parcial/inválida — ignora.
    }
  }
  return out
}

function contentText(content: ContentItem[] | string | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
    .trim()
}

export function digestFromLines(lines: TranscriptLine[]): Digest {
  const userPrompts: string[] = []
  const assistantNotes: string[] = []
  const filesTouched = new Set<string>()
  const refs = new Set<string>()
  const branchesSeen: string[] = []
  const toolRollup: Record<string, number> = {}
  const bashCommands: string[] = []
  let todos: string[] = []
  let finalSummary: string | null = null
  let userTurns = 0
  let editCount = 0

  for (const l of lines) {
    if (l.gitBranch && branchesSeen[branchesSeen.length - 1] !== l.gitBranch) {
      branchesSeen.push(l.gitBranch)
    }
    const role = l.message?.role
    const content = l.message?.content

    if (role === 'user') {
      const text = contentText(content)
      // Mensagens de tool_result voltam como role:user com content estruturado
      // sem texto — só contamos turnos com texto real do usuário.
      if (text && !text.startsWith('<')) {
        userTurns++
        userPrompts.push(text.slice(0, MAX_USER_PROMPT_CHARS))
        for (const m of text.match(PR_RE) ?? []) refs.add(m)
      }
    } else if (role === 'assistant') {
      const text = contentText(content)
      if (text) {
        assistantNotes.push(text.slice(0, MAX_ASSISTANT_TEXT_CHARS))
        finalSummary = text.slice(0, MAX_FINAL_SUMMARY_CHARS)
        for (const m of text.match(PR_RE) ?? []) refs.add(m)
      }
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type !== 'tool_use' || !c.name) continue
          toolRollup[c.name] = (toolRollup[c.name] ?? 0) + 1
          if (c.name === 'Edit' || c.name === 'Write') {
            editCount++
            const fp = c.input?.file_path ?? c.input?.path
            if (fp) filesTouched.add(fp)
          } else if (c.name === 'Bash' && c.input?.command) {
            bashCommands.push(c.input.command.replace(/\s+/g, ' ').trim().slice(0, 120))
          } else if (c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) {
            // Mantém só o snapshot MAIS RECENTE (o TodoWrite é cumulativo).
            todos = c.input.todos
              .filter((t) => t?.content)
              .map((t) => `[${t.status ?? '?'}] ${t.content}`)
          }
        }
      }
    }
  }

  return {
    userPrompts: userPrompts.slice(-MAX_DIGEST_ENTRIES),
    assistantNotes: assistantNotes.slice(-MAX_DIGEST_ENTRIES),
    finalSummary,
    todos: todos.slice(0, MAX_TODOS),
    filesTouched: [...filesTouched],
    toolRollup,
    bashCommands: bashCommands.slice(-MAX_BASH_CMDS),
    gitBranch: pickWorkBranch(branchesSeen),
    refs: [...refs].slice(0, 20),
    userTurns,
    editCount,
  }
}

// Lê o JSONL inteiro UMA vez e produz um digest compacto mas RICO. NUNCA inclui o
// JSONL cru no prompt.
export function buildDigest(path: string): Digest {
  return digestFromLines(parseTranscript(path))
}

// Renderiza o digest enriquecido como entrada para o Stage 1 (registro de sessão).
export function renderDigestForRecord(d: Digest): string {
  const parts: string[] = []
  if (d.gitBranch) parts.push(`Branch: ${d.gitBranch}`)
  if (d.refs.length) parts.push(`Referências citadas (PR/commit): ${d.refs.join(', ')}`)
  const rollup = Object.entries(d.toolRollup)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}×${v}`)
    .join(', ')
  if (rollup) parts.push(`Ferramentas usadas: ${rollup}`)
  if (d.filesTouched.length) {
    parts.push(`Arquivos editados (${d.filesTouched.length}):\n${d.filesTouched.map((f) => `- ${f}`).join('\n')}`)
  }
  if (d.bashCommands.length) {
    parts.push(`Comandos shell (amostra):\n${d.bashCommands.map((c) => `- ${c}`).join('\n')}`)
  }
  if (d.todos.length) {
    parts.push(`Lista de tarefas (último snapshot):\n${d.todos.map((t) => `- ${t}`).join('\n')}`)
  }
  if (d.userPrompts.length) {
    parts.push(`Pedidos do usuário (cronológico):\n${d.userPrompts.map((p) => `- ${p}`).join('\n')}`)
  }
  if (d.finalSummary) {
    parts.push(`Resumo final do assistant:\n${d.finalSummary}`)
  } else if (d.assistantNotes.length) {
    parts.push(`Notas do assistant (cronológico):\n${d.assistantNotes.map((p) => `- ${p}`).join('\n')}`)
  }
  return parts.join('\n\n')
}

// ---- Prompts ----

// Stage 1: destila UMA sessão num registro rico e durável.
export function buildRecordPrompt(feature: Feature, digest: string): string {
  return [
    `Você é um analista que destila UMA sessão de trabalho do Claude Code num registro conciso e factual.`,
    `Esse registro será usado depois para compor a documentação viva da feature "${feature.title}".`,
    '',
    'A partir do RESUMO BRUTO da sessão abaixo, produza um registro em Markdown cobrindo:',
    '- Objetivo da sessão (o que se tentou fazer).',
    '- O que foi feito de concreto (mudanças, implementações, investigações).',
    '- Decisões importantes e o PORQUÊ delas.',
    '- Resultado / estado ao fim da sessão (funcionou? ficou pela metade? bloqueado?).',
    '- Arquivos e referências (PR/commit) relevantes.',
    '- Pontos em aberto / próximos passos, se houver.',
    '',
    'Seja específico e factual — NÃO invente trabalho que não está no resumo. ~150 a 300 palavras.',
    'Devolva APENAS o Markdown do registro (sem frontmatter, sem cercas de código).',
    '',
    '===== RESUMO BRUTO DA SESSÃO =====',
    digest,
  ].join('\n')
}

export function renderRecords(records: SessionRecord[]): string {
  return records
    .map((r) => {
      // Data REAL da sessão (started_at), não a do horário da síntese.
      const date = new Date(r.sessionAt).toISOString().slice(0, 10)
      return `### Sessão — ${date}\n${r.summary}`
    })
    .join('\n\n')
}

// Stage 2: regenera o CORPO inteiro do doc sintetizando todos os registros.
export function buildHolisticPrompt(currentMd: string, records: SessionRecord[]): string {
  return [
    'Você é o curador da documentação viva de uma feature no Pitwall.',
    'Abaixo estão o documento Markdown ATUAL (frontmatter YAML + corpo) e os REGISTROS de TODAS as',
    'sessões de trabalho dessa feature, em ordem cronológica.',
    '',
    'Regenere o CORPO inteiro do documento, sintetizando coerentemente todas as sessões nestas seções',
    'EXATAS, nesta ordem:',
    '',
    '## Visão geral — o que é a feature e por quê (objetivo, escopo, motivação).',
    '## Estado atual — onde está hoje: o que já funciona, o que falta, status geral.',
    '## Decisões — decisões técnicas e de produto tomadas, cada uma com o PORQUÊ (rationale).',
    '## Pontos em aberto — pendências, dúvidas, próximos passos e riscos conhecidos.',
    '## Linha do tempo — narrativa cronológica datada da evolução (conte a história do progresso,',
    '   NÃO uma lista de bullets desconexos).',
    '',
    'Regras:',
    '- No frontmatter YAML, NÃO altere `id` nem `slug`.',
    '- Você PODE refinar o campo `title` se o atual for genérico ou impreciso para o escopo real',
    '  das sessões (ex.: derivado de uma branch/prompt ruim). Caso contrário, mantenha-o.',
    '- Ajuste `status` se as sessões indicarem claramente conclusão ("done") ou trabalho ativo',
    '  ("in-progress"). Mantenha os demais campos do frontmatter inalterados.',
    '- UNA informação repetida entre sessões; não duplique. Prefira coerência a exaustividade.',
    '- Seja específico e factual; não invente. Se uma seção não tem conteúdo real, deixe-a curta.',
    '- Escreva em português.',
    '',
    'Devolva APENAS o Markdown COMPLETO do documento (frontmatter + corpo), sem cercas de código.',
    'A PRIMEIRA linha da resposta DEVE ser exatamente `---` (início do frontmatter). NÃO escreva',
    'nenhuma frase, saudação ou explicação antes do `---`.',
    '',
    '===== DOCUMENTO ATUAL =====',
    currentMd,
    '',
    '===== REGISTROS DAS SESSÕES =====',
    renderRecords(records),
  ].join('\n')
}

// Remove cercas de código markdown que o modelo às vezes envolve no output inteiro.
export function stripCodeFence(s: string): string {
  const t = s.trim()
  if (t.startsWith('```')) {
    const firstNl = t.indexOf('\n')
    const lastFence = t.lastIndexOf('```')
    if (firstNl !== -1 && lastFence > firstNl) {
      return t.slice(firstNl + 1, lastFence).trim()
    }
  }
  return t
}

// Defesa: a LLM às vezes prefixa um preâmbulo conversacional ("Segue o
// documento:") antes do frontmatter, o que faria o gray-matter não achar o `---`
// e a síntese abortar. Remove cercas e corta tudo antes da primeira linha `---`.
export function stripToFrontmatter(s: string): string {
  const t = stripCodeFence(s)
  if (t.startsWith('---')) return t
  const m = t.match(/^---[ \t]*$/m)
  if (m && m.index !== undefined) return t.slice(m.index)
  return t
}

// Valida que o output parseia no gray-matter com frontmatter mínimo (id/title/status).
export function isValidDoc(md: string): boolean {
  if (!md.trim()) return false
  try {
    const parsed = matter(md)
    const fm = parsed.data as { id?: unknown; title?: unknown; status?: unknown }
    return typeof fm.id === 'string' && typeof fm.title === 'string' && typeof fm.status === 'string'
  } catch {
    return false
  }
}
