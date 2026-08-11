// Sonda empírica de DUAS perguntas (investigação do handoff chat-controls):
//
// CASO A (Frente 2) — num prompt de PERMISSÃO de tool real, qual é o `status`
// que o Claude Code escreve em ~/.claude/sessions/<pid>.json no exato momento
// em que o menu está desenhado? O chat só renderiza o card quando o gate
// (gateMenuByStatus) vê 'waiting'; se a CLI reportar 'busy', o card some e o
// usuário é empurrado pro terminal. Correlaciona status × parseTuiMenu a cada
// tick.
//
// CASO B (Frente 1) — o que sobra no JSONL quando se manda \x03 no meio de um
// tool_use? Interrompe um Bash longo e imprime as últimas linhas do transcript.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import xtermHeadless from '@xterm/headless'
import { parseTuiMenu } from '../../src/features/sessions/tui-menu-parser'

const { Terminal } = xtermHeadless as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal
}

function tailText(term: InstanceType<typeof Terminal>, n = 40): string {
  const buf = term.buffer.active
  let text = ''
  for (let y = Math.max(0, buf.length - n); y < buf.length; y++) {
    const line = buf.getLine(y)
    if (line) text += line.translateToString(true) + '\n'
  }
  return text
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function ccStatus(pid: number): string {
  try {
    const raw = readFileSync(join(homedir(), '.claude', 'sessions', `${pid}.json`), 'utf8')
    return String((JSON.parse(raw) as { status?: unknown }).status ?? 'null')
  } catch {
    return 'no-file'
  }
}

async function resolveTrustPrompt(proc: pty.IPty, term: InstanceType<typeof Terminal>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (/trust this folder/i.test(tailText(term, 30))) {
      proc.write('\r')
      await sleep(1500)
      return
    }
    await sleep(300)
  }
}

// Env sem os marcadores herdados da sessão que hospeda a sonda: com
// CLAUDE_CODE_CHILD_SESSION setado a CLI desliga o transcript E o arquivo de
// status em ~/.claude/sessions/<pid>.json — exatamente os dois artefatos que a
// sonda quer observar.
function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue
    if (k.startsWith('CLAUDE_CODE') || k === 'CLAUDECODE') continue
    out[k] = v
  }
  out.TERM = 'xterm-256color'
  return out
}

function spawnClaude(cwd: string, sessionId: string) {
  const term = new Terminal({ cols: 100, rows: 40, allowProposedApi: true })
  const proc = pty.spawn('claude', ['--session-id', sessionId, '--effort', 'low'], {
    name: 'xterm-256color',
    cols: 100,
    rows: 40,
    cwd,
    env: cleanEnv(),
  })
  proc.onData((d) => term.write(d))
  return { term, proc }
}

async function caseA(): Promise<void> {
  console.log('\n=== CASO A: status da CLI durante um prompt de permissão ===')
  const cwd = mkdtempSync(join(tmpdir(), 'probe-perm-'))
  writeFileSync(join(cwd, 'README.md'), '# scratch\n')
  const { term, proc } = spawnClaude(cwd, randomUUID())
  try {
    await sleep(2500)
    await resolveTrustPrompt(proc, term)
    proc.write('Use a tool Write para criar o arquivo nota.txt com o conteudo "oi". Faca isso agora.')
    await sleep(800)
    proc.write('\r')
    const deadline = Date.now() + 90_000
    const seen: string[] = []
    while (Date.now() < deadline) {
      const raw = tailText(term, 40)
      const menu = parseTuiMenu(raw)
      const st = ccStatus(proc.pid)
      const line = `status=${st} menu=${menu ? menu.kind : 'null'}`
      if (seen[seen.length - 1] !== line) {
        seen.push(line)
        console.log(`[tick] ${line}`)
      }
      if (menu) {
        console.log('--- MENU PARSEADO ---')
        console.log(JSON.stringify({ kind: menu.kind, question: menu.question, options: menu.options.map((o) => o.label) }, null, 1))
        console.log(`--- STATUS NO MOMENTO DO MENU: ${st} ---`)
        console.log('--- BUFFER ---')
        console.log(raw.split('\n').filter((l) => l.trim() !== '').join('\n'))
        break
      }
      await sleep(300)
    }
    console.log('TRILHA:', seen.join(' | '))
  } finally {
    try { proc.kill() } catch { /* já morto */ }
    await sleep(300)
  }
}

async function caseB(): Promise<void> {
  console.log('\n=== CASO B: JSONL depois de um Ctrl+C no meio de um tool_use ===')
  const cwd = mkdtempSync(join(tmpdir(), 'probe-int-'))
  writeFileSync(join(cwd, 'README.md'), '# scratch\n')
  const sessionId = randomUUID()
  const { term, proc } = spawnClaude(cwd, sessionId)
  try {
    await sleep(2500)
    await resolveTrustPrompt(proc, term)
    proc.write('Rode `sleep 120` no bash. Só isso.')
    await sleep(800)
    proc.write('\r')
    // Espera o claude começar a trabalhar de fato, depois interrompe.
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (/sleep 120/.test(tailText(term, 40))) break
      await sleep(400)
    }
    console.log('[caseB] status antes do Ctrl+C:', ccStatus(proc.pid))
    await sleep(4000)
    console.log('[caseB] enviando \\x03')
    proc.write('\x03')
    await sleep(6000)
    console.log('[caseB] status depois:', ccStatus(proc.pid))
    console.log('--- TAIL DO BUFFER ---')
    console.log(tailText(term, 25).split('\n').filter((l) => l.trim() !== '').join('\n'))
  } finally {
    try { proc.kill() } catch { /* já morto */ }
    await sleep(1500)
  }
  // Localiza o transcript pelo sessionId e imprime as últimas linhas resumidas.
  const root = join(homedir(), '.claude', 'projects')
  let found: string | null = null
  for (const dir of readdirSync(root)) {
    const p = join(root, dir, `${sessionId}.jsonl`)
    try { readFileSync(p, 'utf8'); found = p; break } catch { /* segue */ }
  }
  if (!found) { console.log('TRANSCRIPT NÃO ENCONTRADO para', sessionId); return }
  console.log('TRANSCRIPT:', found)
  const lines = readFileSync(found, 'utf8').split('\n').filter((l) => l.trim())
  for (const l of lines.slice(-8)) {
    const o = JSON.parse(l) as Record<string, unknown>
    const msg = o.message as { role?: string; content?: unknown } | undefined
    const c = msg?.content
    const blocks = Array.isArray(c)
      ? c.map((b: Record<string, unknown>) => {
          if (b.type === 'text') return `text:${String(b.text).slice(0, 70)}`
          if (b.type === 'tool_use') return `tool_use:${String(b.name)}#${String(b.id).slice(-6)}`
          if (b.type === 'tool_result') return `tool_result#${String(b.tool_use_id).slice(-6)} is_error=${String(b.is_error)} content=${JSON.stringify(b.content).slice(0, 70)}`
          return String(b.type)
        })
      : [`string:${String(c).slice(0, 70)}`]
    console.log(JSON.stringify({
      type: o.type,
      blocks,
      toolUseResult: o.toolUseResult ? Object.fromEntries(Object.entries(o.toolUseResult as object).slice(0, 6)) : undefined,
      topKeys: Object.keys(o).filter((k) => !['parentUuid','isSidechain','userType','cwd','sessionId','version','gitBranch','type','message','uuid','timestamp'].includes(k)),
    }))
  }
}

await caseA()
