import type { TuiMenu, TuiMenuOption } from '../tui-menu-parser'
import { ALWAYS_RE, stripUnsafeDisplay } from '../../../../shared/tui/permission-request'

// Modelo do card de decisão de permissão, derivado do menu parseado da TUI. Puro:
// o shape de entrada vem das capturas reais do 2.1.316 em shared/tui/__fixtures__.

export interface DiffLine {
  sign: '+' | '-' | ' '
  num: string
  text: string
}

export interface PermissionChoice {
  optionIndex: number
  // Label real da TUI: vai no tooltip e decide se o menu mudou antes de enviar.
  optionLabel: string
}

export interface AlwaysChoice extends PermissionChoice {
  // O que fica lembrado, em português — "Sempre" sem escopo é um cheque em branco.
  scope: string
}

export interface PermissionView {
  kind: 'command' | 'file' | 'tool' | 'trust' | 'generic'
  title: string
  // Caminho do arquivo, nome da ferramenta ou nada.
  target?: string
  // Descrição que o próprio Claude deu ("Fetch HTTP headers from example.com").
  description?: string
  command?: string
  diff?: DiffLine[]
  notes: string[]
  approve?: PermissionChoice
  always: AlwaysChoice[]
  deny?: PermissionChoice
  // "Negar e explicar" usa o Tab-to-amend da TUI: só quando o rodapé o oferece.
  canExplainDeny: boolean
}

// "Tip: … choose "switch to auto mode" below": a TUI quebra a frase e o "below"
// sobra sozinho na linha seguinte.
const TIP_LINE_RE = /^Tip:/
const TIP_TAIL_RE = /^[a-z][^A-Z]{0,30}$/
// Cabeçalhos da caixa da TUI: o título do card já diz o que é.
const TOOL_HEADER_RE =
  /^(Bash command|Edit file|Create file|Write file|Read file|Fetch|Web fetch|Web search|Tool use)$/i

export function contextLines(context: string): string[] {
  const out: string[] = []
  let afterTip = false
  for (const raw of stripUnsafeDisplay(context).split('\n')) {
    const line = raw.trim()
    if (TIP_LINE_RE.test(line)) {
      afterTip = !/[.!?]$/.test(line)
      continue
    }
    if (afterTip && TIP_TAIL_RE.test(line)) {
      afterTip = false
      continue
    }
    afterTip = false
    if (TOOL_HEADER_RE.test(line)) continue
    out.push(raw)
  }
  return out
}

function shortPath(path: string): string {
  const parts = path.replace(/\s+/g, '').split('/').filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

// O que o "Sempre" concede. A TUI quebra o caminho longo entre o label e a
// descrição da opção; os dois juntos refazem a frase.
export function alwaysHintText(label: string, description?: string): string {
  const full = `${label}${description ? ` ${description}` : ''}`
  const access = /always allow access to (.+?) from this project/i.exec(full)
  if (access) return `permitir acesso a ${shortPath(access[1])} em todo o projeto`
  const forCmd = /don[’']t ask again for:\s*(.+)$/i.exec(full)
  if (forCmd) return `não perguntar de novo para ${forCmd[1].trim()}`
  const mcp = /don[’']t ask again for (.+?) commands in/i.exec(full)
  if (mcp) return `não perguntar de novo para ${mcp[1].trim()} nesta pasta`
  if (/don[’']t ask again/i.test(full)) return 'não perguntar de novo por este comando'
  if (/allow all edits/i.test(full)) return 'permitir todas as edições nesta sessão'
  if (/accept edits/i.test(full)) return 'aceitar edições de arquivo sem perguntar nesta sessão'
  if (/auto mode/i.test(full)) return 'ligar o modo automático: o Claude decide os próximos pedidos'
  if (/remember this directory/i.test(full)) return 'lembrar desta pasta'
  return label
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

const DIFF_SIGNED_RE = /^(\d+) ([+-])(.*)$/
const DIFF_PLAIN_RE = /^(\d+) {1,2}(.*)$/

function parseDiff(lines: string[], created: boolean): DiffLine[] {
  const out: DiffLine[] = []
  for (const raw of lines) {
    const line = raw.trim()
    const signed = DIFF_SIGNED_RE.exec(line)
    if (signed) {
      out.push({ num: signed[1], sign: signed[2] as '+' | '-', text: signed[3] })
      continue
    }
    const plain = DIFF_PLAIN_RE.exec(line)
    // Arquivo novo vem sem sinal ("1 alfa"): tudo é adição.
    if (plain) out.push({ num: plain[1], sign: created ? '+' : ' ', text: plain[2] })
  }
  return out
}

function choice(option: TuiMenuOption | undefined): PermissionChoice | undefined {
  return option ? { optionIndex: option.index, optionLabel: option.label } : undefined
}

function choices(menu: TuiMenu) {
  const deny = menu.options.find((o) => /^No\b/i.test(o.label))
  const always = menu.options
    .filter((o) => o !== deny && ALWAYS_RE.test(o.label))
    .map((o) => ({
      optionIndex: o.index,
      optionLabel: o.label,
      scope: alwaysHintText(o.label, o.description),
    }))
  const approve = menu.options.find(
    (o) => o !== deny && /^Yes\b/i.test(o.label) && !always.some((a) => a.optionIndex === o.index),
  )
  return { approve: choice(approve), always, deny: choice(deny) }
}

const FILE_TOOLS: Record<string, string> = { Edit: 'editar', Create: 'criar', Write: 'escrever em' }

function describeFile(menu: TuiMenu, lines: string[], tool: string): Partial<PermissionView> {
  const path = menu.request?.command ?? ''
  const created = tool === 'Create'
  const body = lines.filter((l) => l.trim() !== path)
  const diff = parseDiff(body, created)
  return {
    kind: 'file',
    title: `Claude quer ${FILE_TOOLS[tool]} ${basename(path)}`,
    target: path,
    diff,
    notes: body.filter((l) => !DIFF_SIGNED_RE.test(l.trim()) && !DIFF_PLAIN_RE.test(l.trim())),
  }
}

function describeCommand(menu: TuiMenu, lines: string[]): Partial<PermissionView> {
  const command = menu.request?.command ?? ''
  const at = lines.findIndex((l) => l.trim() !== '' && command.includes(l.trim()))
  const before = at < 0 ? [] : lines.slice(0, at).filter((l) => l.trim() !== '')
  const after = (at < 0 ? lines : lines.slice(at)).filter((l) => !command.includes(l.trim()))
  return {
    kind: 'command',
    title: 'Claude quer rodar um comando',
    command: stripUnsafeDisplay(command),
    description: before.join(' ') || undefined,
    notes: after,
  }
}

function describeTool(menu: TuiMenu, lines: string[]): Partial<PermissionView> {
  const tool = menu.request?.tool ?? ''
  return {
    kind: 'tool',
    title: `Claude quer usar ${tool}`,
    target: tool,
    notes: lines.filter((l) => !l.includes('Tool: (MCP)')),
  }
}

export function permissionView(menu: TuiMenu): PermissionView {
  const lines = menu.context ? contextLines(menu.context) : []
  const tool = menu.request?.tool
  const base: Partial<PermissionView> =
    menu.kind === 'trust'
      ? { kind: 'trust', title: 'Confiar nesta pasta?', notes: lines }
      : tool && FILE_TOOLS[tool] && menu.request?.command
        ? describeFile(menu, lines, tool)
        : tool === 'Bash'
          ? describeCommand(menu, lines)
          : tool
            ? describeTool(menu, lines)
            : { kind: 'generic', title: 'Claude pede permissão', notes: lines }
  const picked = choices(menu)
  return {
    kind: base.kind ?? 'generic',
    title: base.title ?? 'Claude pede permissão',
    notes: base.notes ?? [],
    ...base,
    ...picked,
    canExplainDeny: menu.kind === 'permission' && !!menu.amendable && picked.deny != null,
  }
}

export function pendingElsewhereLabel(n: number): string {
  return n === 1 ? '1 sessão aguardando você' : `${n} sessões aguardando você`
}
