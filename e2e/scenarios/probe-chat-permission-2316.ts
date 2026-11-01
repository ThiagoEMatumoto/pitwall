// Sonda ao vivo: permissões do claude 2.1.316 (Bash, Write, Edit, MCP, trust, Tab-amend,
// AskUserQuestion+Esc). Grava telas em OUT/<step>.txt e um log com parse + status.
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { createRequire } from 'node:module'
const xtermHeadless = createRequire(import.meta.url)(
  process.env.XTERM_HEADLESS ?? '@xterm/headless',
)
import { parseTuiMenu } from '../../shared/tui/tui-menu-parser'
import { AMEND_KEY_DELAY_MS, buildAmendKeys, playKeys } from '../../shared/tui/respond-keys'

const { Terminal } = xtermHeadless as unknown as {
  Terminal: new (o: Record<string, unknown>) => any
}
const SB =
  '/home/thiagoematumoto/.cache/ct/claude-1000/-home-thiagoematumoto-projetos-pessoal-claude-manager/07f79ab4-0c03-407c-bee9-5868ed5ea665/scratchpad/sandbox-084'
const CWD = join(SB, 'perm')
const OUT = join(SB, process.env.PROBE_OUT ?? 'captures')
const ONLY = process.argv[2] ?? 'all'
mkdirSync(OUT, { recursive: true })
rmSync(CWD, { recursive: true, force: true })
mkdirSync(join(CWD, 'src'), { recursive: true })
writeFileSync(join(CWD, 'README.md'), '# sandbox\n')
writeFileSync(
  join(CWD, 'src', 'app.js'),
  Array.from({ length: 30 }, (_, i) => `export const value${i} = ${i} // linha ${i}`).join('\n') +
    '\n',
)
const MCP_SERVER = join(SB, 'mcp-echo.mjs')
writeFileSync(
  MCP_SERVER,
  `import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
rl.on('line', (l) => {
  let m; try { m = JSON.parse(l) } catch { return }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } })
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'shout', description: 'Repete o texto em maiusculas', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } })
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(m.params.arguments.text).toUpperCase() }] } })
  else if (m.id != null) send({ jsonrpc: '2.0', id: m.id, result: {} })
})
`,
)
const MCP_CONFIG = join(SB, 'mcp.json')
writeFileSync(
  MCP_CONFIG,
  JSON.stringify({
    mcpServers: { echo: { command: 'node', args: [MCP_SERVER] } },
  }),
)

const COLS = 120
const ROWS = 45
const term = new Terminal({
  cols: COLS,
  rows: ROWS,
  allowProposedApi: true,
  scrollback: 2000,
})
const env: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) {
  if (v == null || k.startsWith('CLAUDE_CODE') || k === 'CLAUDECODE') continue
  env[k] = v
}
env.TERM = 'xterm-256color'
const sessionId = randomUUID()
const proc = pty.spawn(
  'claude',
  [
    '--session-id',
    sessionId,
    '--effort',
    'low',
    '--setting-sources',
    'project,local',
    '--permission-mode',
    'default',
    '--mcp-config',
    MCP_CONFIG,
    '--strict-mcp-config',
  ],
  { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: CWD, env },
)
let raw = ''
proc.onData((d) => {
  raw += d
  term.write(d)
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function tail(n = 80): string {
  const buf = term.buffer.active
  let t = ''
  for (let y = Math.max(0, buf.length - n); y < buf.length; y++)
    t += (buf.getLine(y)?.translateToString(true) ?? '') + '\n'
  return t
}
function ccStatus(): string {
  try {
    return String(
      JSON.parse(readFileSync(join(homedir(), '.claude', 'sessions', `${proc.pid}.json`), 'utf8'))
        .status ?? 'null',
    )
  } catch {
    return 'no-file'
  }
}
const log: string[] = []
function dump(step: string) {
  const t = tail(80)
  writeFileSync(join(OUT, `${step}.txt`), t)
  const m = parseTuiMenu(t)
  const line = `[${step}] status=${ccStatus()} menu=${m ? JSON.stringify({ kind: m.kind, q: m.question, req: m.request, opts: m.options.map((o) => o.label), ctx: m.context }) : 'null'}`
  log.push(line)
  console.log(line)
  writeFileSync(join(OUT, 'log.txt'), log.join('\n') + `\nsession=${sessionId}\n`)
}
async function waitMenu(kind: string | null, timeout = 120_000): Promise<boolean> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const m = parseTuiMenu(tail(80))
    if (m && (kind == null || m.kind === kind)) {
      await sleep(600)
      return true
    }
    await sleep(300)
  }
  return false
}
async function waitIdle(timeout = 120_000) {
  const end = Date.now() + timeout
  await sleep(1500)
  while (Date.now() < end) {
    const s = ccStatus()
    if ((s === 'idle' || s === 'waiting') && !parseTuiMenu(tail(80))) return
    await sleep(500)
  }
}
async function prompt(text: string) {
  proc.write(text)
  await sleep(700)
  proc.write('\r')
}

try {
  await sleep(3000)
  dump('00-start')
  if (await waitMenu('trust', 8000)) {
    dump('01-trust')
    proc.write('\r')
    await sleep(2500)
  }
  dump('02-after-trust')

  if (ONLY === 'all' || ONLY === 'ask') {
    await prompt(
      'Use a ferramenta AskUserQuestion para me perguntar qual cor eu prefiro (opcoes: azul, verde). Nao faca mais nada.',
    )
    if (await waitMenu('question')) {
      dump('10-ask')
      proc.write('\x1b')
      await sleep(3000)
      dump('11-ask-esc')
    }
    await waitIdle(30_000)
  }

  if (ONLY === 'all' || ONLY === 'bash') {
    await prompt('Rode exatamente este comando bash e nada mais: curl -sI https://example.com')
    if (await waitMenu('permission')) {
      dump('20-bash')
      // Negar com explicação: desce até "No" (última opção), Tab (amend), digita e Enter.
      const opts = parseTuiMenu(tail(80))?.options.length ?? 3
      for (let i = 1; i < opts; i++) {
        proc.write('\x1b[B')
        await sleep(300)
      }
      await sleep(400)
      dump('21-bash-cursor-no')
      proc.write('\t')
      await sleep(1200)
      dump('22-bash-tab')
      proc.write('use wget em vez de curl')
      await sleep(800)
      dump('23-bash-typed')
      proc.write('\r')
      await sleep(4000)
      dump('24-bash-after')
    }
    await waitIdle(60_000)
    dump('25-bash-idle')
  }

  // Mesmas teclas e atraso que o main manda para { kind: "amend" }.
  if (ONLY === 'amend') {
    await prompt('Rode exatamente este comando bash e nada mais: curl -sI https://example.com')
    if (await waitMenu('permission')) {
      dump('50-amend-before')
      const menu = parseTuiMenu(tail(80))!
      const deny = menu.options.find((o) => /^No\b/.test(o.label))!
      const keys = buildAmendKeys(menu, deny.index, 'nao use rede; responda so OK')
      console.log('keys', JSON.stringify(keys))
      await playKeys(keys, (s) => proc.write(s), AMEND_KEY_DELAY_MS)
      await sleep(1500)
      dump('51-amend-sent')
    }
    await waitIdle(60_000)
    dump('52-amend-idle')
  }

  if (ONLY === 'all' || ONLY === 'write') {
    await prompt('Crie o arquivo notas.txt com tres linhas: alfa, beta, gama. Use a tool Write.')
    if (await waitMenu('permission')) {
      dump('30-write')
      proc.write('1')
      await sleep(3000)
    }
    await waitIdle(60_000)
    await prompt(
      'Na src/app.js, troque os comentarios das linhas value3 a value12 por "// editado". Use uma unica chamada da tool Edit (ou MultiEdit).',
    )
    if (await waitMenu('permission')) {
      dump('31-edit')
      // Tab no "Yes": amend de aprovação?
      proc.write('\t')
      await sleep(1200)
      dump('32-edit-tab-on-yes')
      proc.write('\x1b')
      await sleep(1500)
      dump('33-edit-esc-from-amend')
      if (parseTuiMenu(tail(80))) {
        proc.write('1')
        await sleep(3000)
      }
    }
    await waitIdle(60_000)
    dump('34-edit-idle')
  }

  if (ONLY === 'all' || ONLY === 'mcp') {
    await prompt('Chame a ferramenta MCP shout do servidor echo com text="oi". So isso.')
    if (await waitMenu('permission')) {
      dump('40-mcp')
      proc.write('1')
      await sleep(3000)
    }
    await waitIdle(60_000)
    dump('41-mcp-idle')
  }
} finally {
  writeFileSync(join(OUT, 'raw.ansi'), raw)
  try {
    proc.kill()
  } catch {}
  await sleep(500)
  console.log('session', sessionId)
  process.exit(0)
}
