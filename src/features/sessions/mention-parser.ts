import type { SendTarget } from '@/features/quick-composer/target-search'

// Menções do composer. `@alias` no INÍCIO troca a sessão de destino; `#caminho`
// escolhido no menu vira `@caminho` (a menção de arquivo que o Claude Code
// entende), relativo ao cwd do destino. Puro: o Composer e o QuickComposer
// decidem o que fazer.

export type MentionKind = 'session' | 'file'

export interface ActiveToken {
  kind: MentionKind
  query: string
  start: number
  end: number
}

// Alias de sessão é slug (aliasOf): sem ponto nem barra. `@src/x.ts` e
// `@README.md` continuam sendo menção de arquivo pro claude.
const LEADING_ALIAS_RE = /^\s*@([A-Za-z0-9_-]+)(?=\s|$)/
// `@agent-<nome>` é a menção de subagente do próprio Claude Code.
const CLAUDE_AGENT_PREFIX = 'agent-'
const ALIAS_QUERY_RE = /^[A-Za-z0-9_-]*$/
const FILE_TOKEN_RE = /(^|\s)#([^\s#]+)/g
// Digitado à mão sem o menu: só caminho relativo com pasta e extensão
// (`#src/x.ts`). Shebang, `#/json-pointer`, `#v1.2` e `#app.dark` não casam.
const TYPED_FILE_RE = /^[A-Za-z0-9_][\w.-]*(\/[\w.-]+)+\.[A-Za-z0-9]+$/

function isAliasQuery(q: string): boolean {
  return ALIAS_QUERY_RE.test(q) && !q.toLowerCase().startsWith(CLAUDE_AGENT_PREFIX)
}

export function activeMentionToken(text: string, caret: number): ActiveToken | null {
  let start = caret
  while (start > 0 && !/\s/.test(text[start - 1])) start--
  let end = caret
  while (end < text.length && !/\s/.test(text[end])) end++
  const sigil = text[start]
  const query = text.slice(start + 1, end)
  if (sigil === '@' && text.slice(0, start).trim() === '' && isAliasQuery(query)) {
    return { kind: 'session', query, start, end }
  }
  if (sigil === '#') return { kind: 'file', query, start, end }
  return null
}

export function applyCompletion(
  text: string,
  token: ActiveToken,
  replacement: string,
): { value: string; caret: number } {
  const after = text.slice(token.end)
  const spaced = /^\s/.test(after) ? after : ` ${after}`
  return {
    value: text.slice(0, token.start) + replacement + spaced,
    caret: token.start + replacement.length + 1,
  }
}

function relativeTo(path: string, cwd: string | null): string {
  if (!cwd || !path.startsWith('/')) return path
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`
  return path.startsWith(base) ? path.slice(base.length) : path
}

// Os caminhos escolhidos no menu, mais o caminho relativo inequívoco: o resto do
// texto colado (shebang, #v1.2, #app.dark, JSON pointer) chega como foi escrito.
export function rewriteFileMentions(
  body: string,
  cwd: string | null,
  picked: ReadonlySet<string>,
): string {
  return body.replace(FILE_TOKEN_RE, (whole, lead: string, path: string) =>
    picked.has(path) || TYPED_FILE_RE.test(path) ? `${lead}@${relativeTo(path, cwd)}` : whole,
  )
}

export type ParsedSend =
  | { kind: 'ok'; target: SendTarget; body: string }
  | { kind: 'no-match'; alias: string }
  | { kind: 'ambiguous'; alias: string; candidates: SendTarget[] }
  | { kind: 'no-target' }
  | { kind: 'empty' }

export function parseSend(
  text: string,
  targets: SendTarget[],
  fallback: SendTarget | null,
  pickedFiles: ReadonlySet<string> = new Set(),
): ParsedSend {
  const m = LEADING_ALIAS_RE.exec(text)
  const alias = m && isAliasQuery(m[1]) ? m[1] : null
  let target = fallback
  let rest = text
  if (alias && m) {
    const wanted = alias.toLowerCase()
    const candidates = targets.filter((t) => t.alias.toLowerCase() === wanted)
    if (candidates.length === 0) return { kind: 'no-match', alias }
    if (candidates.length > 1) return { kind: 'ambiguous', alias, candidates }
    target = candidates[0]
    rest = text.slice(m[0].length)
  }
  if (!target) return { kind: 'no-target' }
  const body = rewriteFileMentions(rest.trim(), target.cwd, pickedFiles)
  if (body === '') return { kind: 'empty' }
  return { kind: 'ok', target, body }
}

// Subsequência com bônus pra prefixo e letras seguidas. null = não casa.
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (q === '') return 0
  if (t.startsWith(q)) return 1000 - t.length
  const idx = t.indexOf(q)
  if (idx >= 0) return 500 - idx
  let score = 0
  let ti = 0
  let prev = -2
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return null
    score += found === prev + 1 ? 5 : 1
    prev = found
    ti = found + 1
  }
  return score
}

export function filterFiles(query: string, files: string[], limit: number): string[] {
  if (query === '') return files.slice(0, limit)
  const scored: Array<{ file: string; score: number }> = []
  for (const file of files) {
    const base = file.slice(file.lastIndexOf('/', file.length - 2) + 1)
    const s = Math.max(fuzzyScore(query, base) ?? -1, (fuzzyScore(query, file) ?? -1) - 1)
    if (s >= 0) scored.push({ file, score: s })
  }
  scored.sort((a, b) => b.score - a.score || a.file.length - b.file.length)
  return scored.slice(0, limit).map((s) => s.file)
}
