import type { DiffLine } from './permission-view'

// Apresentação das chamadas de ferramenta do transcript. Puro: o input vem do
// tool_use gravado pela CLI (shape do Claude Code: file_path, command, pattern,
// old_string/new_string, edits[]…); campo ausente cai no resumo genérico.

export type ToolCategory = 'read' | 'edit' | 'bash' | 'search' | 'web' | 'task' | 'other'

export interface ToolView {
  category: ToolCategory
  // Rótulo curto da linha fechada: o que foi feito, em português.
  label: string
  // Alvo principal (arquivo, comando, padrão, URL), já encurtado para a linha.
  target: string
  // Complemento discreto (faixa de linhas, descrição do comando, +a −r).
  meta?: string
  // Comando completo do Bash, pro bloco "$ …" do card aberto.
  command?: string
  // Diff de Edit/MultiEdit/Write, renderizado com o DiffBlock do PermissionCard.
  diff?: DiffLine[]
}

const CATEGORY: Record<string, ToolCategory> = {
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'bash',
  BashOutput: 'bash',
  KillShell: 'bash',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
  Task: 'task',
  Agent: 'task',
}

export function toolCategory(name: string): ToolCategory {
  return CATEGORY[name.trim()] ?? 'other'
}

function str(input: unknown, key: string): string {
  if (input == null || typeof input !== 'object') return ''
  const v = (input as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

function num(input: unknown, key: string): number | null {
  if (input == null || typeof input !== 'object') return null
  const v = (input as Record<string, unknown>)[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// Os dois últimos segmentos bastam pra reconhecer o arquivo; o caminho inteiro
// fica no tooltip e no card aberto.
export function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? ''
  return line.trim()
}

export function oneLine(value: unknown, max = 140): string {
  let s: string
  if (value == null) s = ''
  else if (typeof value === 'string') s = value
  else {
    try {
      s = JSON.stringify(value)
    } catch {
      s = String(value)
    }
  }
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

function splitLines(text: string): string[] {
  if (text === '') return []
  return text.replace(/\n$/, '').split('\n')
}

// Acima disto o LCS (O(n·m)) pesa no render; o diff vira "tudo saiu, tudo entrou".
const LCS_CELL_LIMIT = 250_000

// Diff de linhas entre o trecho antigo e o novo de um Edit. A CLI não grava o
// número de linha no input, então a coluna fica vazia em vez de inventar um.
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)
  if (a.length * b.length > LCS_CELL_LIMIT) {
    return [
      ...a.map((text) => ({ sign: '-' as const, num: '', text })),
      ...b.map((text) => ({ sign: '+' as const, num: '', text })),
    ]
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ sign: ' ', num: '', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ sign: '-', num: '', text: a[i++] })
    } else {
      out.push({ sign: '+', num: '', text: b[j++] })
    }
  }
  while (i < a.length) out.push({ sign: '-', num: '', text: a[i++] })
  while (j < b.length) out.push({ sign: '+', num: '', text: b[j++] })
  return out
}

function editDiff(name: string, input: unknown): DiffLine[] | undefined {
  if (name === 'Write') {
    const content = str(input, 'content')
    return splitLines(content).map((text, i) => ({ sign: '+', num: String(i + 1), text }))
  }
  if (name === 'MultiEdit') {
    const edits = (input as { edits?: unknown } | null)?.edits
    if (!Array.isArray(edits)) return undefined
    const out: DiffLine[] = []
    edits.forEach((e, k) => {
      if (k > 0) out.push({ sign: ' ', num: '', text: '⋯' })
      out.push(...lineDiff(str(e, 'old_string'), str(e, 'new_string')))
    })
    return out
  }
  if (name === 'Edit') {
    const before = str(input, 'old_string')
    const after = str(input, 'new_string')
    if (!before && !after) return undefined
    return lineDiff(before, after)
  }
  return undefined
}

function diffMeta(diff: DiffLine[] | undefined): string | undefined {
  if (!diff) return undefined
  const added = diff.filter((l) => l.sign === '+').length
  const removed = diff.filter((l) => l.sign === '-').length
  return removed === 0 ? `+${added}` : `+${added} −${removed}`
}

function readRange(input: unknown): string | undefined {
  const offset = num(input, 'offset')
  const limit = num(input, 'limit')
  if (offset == null && limit == null) return undefined
  const start = offset ?? 1
  return limit != null ? `linhas ${start}–${start + limit - 1}` : `a partir da linha ${start}`
}

export function toolView(name: string, input: unknown): ToolView {
  const category = toolCategory(name)
  const path = str(input, 'file_path') || str(input, 'notebook_path') || str(input, 'path')
  switch (name) {
    case 'Read':
    case 'NotebookRead':
      return { category, label: 'Leu', target: shortPath(path), meta: readRange(input) }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const diff = editDiff(name, input)
      return {
        category,
        label: name === 'Write' ? 'Escreveu' : 'Editou',
        target: shortPath(path),
        meta: diffMeta(diff),
        diff,
      }
    }
    case 'Bash': {
      const command = str(input, 'command')
      return {
        category,
        label: 'Rodou',
        target: firstLine(command),
        meta: str(input, 'description') || undefined,
        command,
      }
    }
    case 'Grep':
      return {
        category,
        label: 'Buscou',
        target: str(input, 'pattern'),
        meta: path ? `em ${shortPath(path)}` : str(input, 'glob') || undefined,
      }
    case 'Glob':
      return {
        category,
        label: 'Listou',
        target: str(input, 'pattern'),
        meta: path ? `em ${shortPath(path)}` : undefined,
      }
    case 'WebFetch':
      return { category, label: 'Abriu', target: str(input, 'url') }
    case 'WebSearch':
      return { category, label: 'Pesquisou', target: str(input, 'query') }
    default:
      return { category, label: name, target: oneLine(input) }
  }
}

// Resumo de um grupo de chamadas seguidas: "leu 6 arquivos · rodou 3 comandos".
const PHRASES: Record<ToolCategory, [string, string]> = {
  read: ['leu 1 arquivo', 'leu {n} arquivos'],
  edit: ['editou 1 arquivo', 'editou {n} arquivos'],
  bash: ['rodou 1 comando', 'rodou {n} comandos'],
  search: ['fez 1 busca', 'fez {n} buscas'],
  web: ['abriu 1 página', 'abriu {n} páginas'],
  task: ['chamou 1 subagente', 'chamou {n} subagentes'],
  other: ['usou 1 ferramenta', 'usou {n} ferramentas'],
}
const ORDER: ToolCategory[] = ['read', 'search', 'edit', 'bash', 'web', 'task', 'other']

export function summarizeTools(names: string[], errors = 0): string {
  const counts = new Map<ToolCategory, number>()
  for (const n of names) {
    const c = toolCategory(n)
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  const parts = ORDER.filter((c) => counts.has(c)).map((c) => {
    const n = counts.get(c)!
    const [one, many] = PHRASES[c]
    return n === 1 ? one : many.replace('{n}', String(n))
  })
  if (errors > 0) parts.push(errors === 1 ? '1 erro' : `${errors} erros`)
  const text = parts.join(' · ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// Saída longa abre nas primeiras linhas; o resto fica atrás de "mostrar mais".
export function previewLines(text: string, max: number): { shown: string; hidden: number } {
  const lines = text.replace(/\n+$/, '').split('\n')
  if (lines.length <= max) return { shown: lines.join('\n'), hidden: 0 }
  return { shown: lines.slice(0, max).join('\n'), hidden: lines.length - max }
}
