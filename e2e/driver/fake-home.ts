import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// HOME falso + CLIs falsas para cenários do drive-app que spawnam sessões.
//
// O app observa as sessões vivas por ~/.claude/sessions/<pid>.json (ver
// electron/main/services/session-activity.ts). Com HOME apontado pra cá, o
// ~/.claude do usuário real não é lido nem tocado, e o status de cada sessão
// fica sob controle do cenário (setStatus). O binário é trocado pelo stub via
// app_prefs.claude_command = fakeCliPath('claude') — nenhuma API é chamada.

export type FakeCliProvider = 'claude' | 'codex'

// Subconjunto dos status que o Claude Code grava e o app mapeia:
// busy → trabalhando, waiting → esperando, idle → ocioso.
export type FakeSessionStatus = 'busy' | 'waiting' | 'idle'

export interface SessionFileInput {
  sessionId: string
  cwd: string
  status: FakeSessionStatus
  name?: string | null
}

// Shape gravado em sessions/<pid>.json: os campos que buildSessionsFileIndex lê
// (pid, sessionId, cwd, status, name, updatedAt) mais startedAt. O arquivo real
// do Claude Code tem outros campos que o app ignora.
export interface SessionFile {
  pid: number
  sessionId: string
  cwd: string
  status: FakeSessionStatus
  name: string | null
  startedAt: number
  updatedAt: number
}

export interface FakeSessionEntry {
  file: string
  data: SessionFile
}

export interface FakeHomeOptions {
  // Diretório onde o root temporário é criado. Default: os.tmpdir().
  parentDir?: string
}

export interface FakeHome {
  // Dir temporário que contém tudo abaixo; é o que cleanup() remove.
  root: string
  // O HOME falso (tem .zshrc/.zshenv vazios e ~/.claude/{sessions,projects}).
  home: string
  sessionsDir: string
  // Um log por processo de CLI falsa: <provider>-<pid>.log com argv e stdin.
  logDir: string
  // Env a passar ao launchApp({ env }) — o main e as PTYs herdam o HOME.
  env: Record<string, string>
  writeSessionFile(pid: number, input: SessionFileInput): string
  setStatus(pid: number, status: FakeSessionStatus): void
  readSessionFiles(): FakeSessionEntry[]
  fakeCliPath(provider: FakeCliProvider): string
  // Concatena os logs de todas as execuções daquele provider.
  readCliLog(provider: FakeCliProvider): string
  cleanup(): void
}

export function buildSessionFile(pid: number, input: SessionFileInput, now: number): SessionFile {
  return {
    pid,
    sessionId: input.sessionId,
    cwd: input.cwd,
    status: input.status,
    name: input.name ?? null,
    startedAt: now,
    updatedAt: now,
  }
}

export function withStatus(file: SessionFile, status: FakeSessionStatus, now: number): SessionFile {
  return { ...file, status, updatedAt: now }
}

function shSingleQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

// Trecho comum aos dois stubs: log por PID + loop que ecoa cada linha do stdin.
// O app injeta prompts via bracketed-paste (ESC[200~ … ESC[201~); os marcadores
// são removidos antes de logar pra o cenário poder comparar o texto puro.
function echoLoop(logDir: string, provider: FakeCliProvider, prompt: string): string {
  return `LOG=${shSingleQuote(logDir)}/${provider}-$$.log
printf 'argv:' >> "$LOG"
for a in "$@"; do printf ' %q' "$a" >> "$LOG"; done
printf '\\n' >> "$LOG"

echo_loop() {
  printf '%s' ${shSingleQuote(prompt)}
  while IFS= read -r line; do
    line=\${line//$'\\e[200~'/}
    line=\${line//$'\\e[201~'/}
    line=\${line%$'\\r'}
    printf 'stdin: %s\\n' "$line" >> "$LOG"
    printf 'recebido: %s\\n' "$line"
    printf '%s' ${shSingleQuote(prompt)}
  done
}`
}

// Caixa de input ociosa do claude 2.1.286 (régua, "❯ ", régua): é a prova
// positiva que a fila de envio exige antes de escrever na sessão.
// 50 colunas (não a largura toda): não quebra linha em PTY estreita.
const INPUT_RULE = '─'.repeat(50)
const CLAUDE_INPUT_BOX = `\n${INPUT_RULE}\n❯ \n${INPUT_RULE}\n`

// Stub do `claude`: lê --session-id/--resume e -n do comando montado por
// buildSpawnInnerCmd, grava sessions/<pid>.json com status 'busy' (a sessão
// "trabalhando") e fica viva ecoando o stdin. O caminho do sessionsDir é
// embutido (não $HOME) pra não depender do env que a PTY recebe.
export function fakeClaudeScript(sessionsDir: string, logDir: string): string {
  return `#!/usr/bin/env bash
# Stub do claude para cenários e2e — gerado por e2e/driver/fake-home.ts.
SESSIONS_DIR=${shSingleQuote(sessionsDir)}
${echoLoop(logDir, 'claude', CLAUDE_INPUT_BOX)}

session_id=''
name=''
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id|--resume) session_id="$2"; shift 2 ;;
    -n|--name) name="$2"; shift 2 ;;
    *) shift ;;
  esac
done

json_str() {
  local s=\${1//\\\\/\\\\\\\\}
  s=\${s//\\"/\\\\\\"}
  printf '"%s"' "$s"
}

now=$(date +%s%3N)
if [ -n "$name" ]; then name_json=$(json_str "$name"); else name_json=null; fi
printf '{"pid":%s,"sessionId":%s,"cwd":%s,"status":"busy","name":%s,"startedAt":%s,"updatedAt":%s}' \\
  "$$" "$(json_str "$session_id")" "$(json_str "$PWD")" "$name_json" "$now" "$now" \\
  > "$SESSIONS_DIR/$$.json"

printf '\\u256d\\u2500 Fake Claude Code (stub e2e)\\n'
printf '\\u2502  sessao: %s\\n' "$session_id"
printf '\\u2502  cwd:    %s\\n' "$PWD"
# Nome por último e sem linha em branco antes da caixa de input: a prévia do
# "enviar para" mostra só as 6 últimas linhas, e é o nome que prova de quem é a tela.
printf '\\u2502  nome:   %s\\n' "$name"
printf '\\u2570\\u2500\\n'
echo_loop
`
}

// Stub do `codex`: banner no formato da TUI do Codex + eco do stdin. Não grava
// nada em ~/.claude/sessions — o Codex real não escreve ali.
export function fakeCodexScript(logDir: string): string {
  return `#!/usr/bin/env bash
# Stub do codex para cenários e2e — gerado por e2e/driver/fake-home.ts.
${echoLoop(logDir, 'codex', '\u203a ')}

printf '\\u256d%s\\u256e\\n' '──────────────────────────────────────────────────'
printf '\\u2502 %-49s\\u2502\\n' '>_ OpenAI Codex (fake stub e2e)'
printf '\\u2502 %-49s\\u2502\\n' ''
printf '\\u2502 %-49s\\u2502\\n' 'model:     gpt-5-codex   /model to change'
printf '\\u2502 %-49s\\u2502\\n' "directory: $PWD"
printf '\\u2570%s\\u256f\\n\\n' '──────────────────────────────────────────────────'
printf '  To get started, describe a task or try one of these commands:\\n\\n'
printf '  /init - create an AGENTS.md file with instructions for Codex\\n'
printf '  /status - show current session configuration\\n\\n'
if [ $# -gt 0 ]; then printf 'prompt inicial: %s\\n' "$*"; fi
echo_loop
`
}

export function createFakeHome(opts: FakeHomeOptions = {}): FakeHome {
  const root = mkdtempSync(join(opts.parentDir ?? tmpdir(), 'cm-fake-home-'))
  const home = join(root, 'home')
  const sessionsDir = join(home, '.claude', 'sessions')
  const logDir = join(root, 'logs')
  const binDir = join(root, 'bin')
  for (const dir of [sessionsDir, join(home, '.claude', 'projects'), logDir, binDir]) {
    mkdirSync(dir, { recursive: true })
  }
  // O spawn usa `zsh -l -i -c`; sem ~/.zshrc o zsh dispara o zsh-newuser-install
  // e FICA PARADO num prompt interativo — a sessão nunca sobe.
  writeFileSync(join(home, '.zshrc'), '')
  writeFileSync(join(home, '.zshenv'), '')

  const cliPaths: Record<FakeCliProvider, string> = {
    claude: join(binDir, 'fake-claude.sh'),
    codex: join(binDir, 'fake-codex.sh'),
  }
  writeFileSync(cliPaths.claude, fakeClaudeScript(sessionsDir, logDir))
  writeFileSync(cliPaths.codex, fakeCodexScript(logDir))
  chmodSync(cliPaths.claude, 0o755)
  chmodSync(cliPaths.codex, 0o755)

  const sessionPath = (pid: number) => join(sessionsDir, `${pid}.json`)

  return {
    root,
    home,
    sessionsDir,
    logDir,
    env: { HOME: home },
    writeSessionFile(pid, input) {
      const file = sessionPath(pid)
      writeFileSync(file, JSON.stringify(buildSessionFile(pid, input, Date.now())))
      return file
    },
    setStatus(pid, status) {
      const file = sessionPath(pid)
      if (!existsSync(file)) throw new Error(`setStatus: não existe session file para o pid ${pid}`)
      const current = JSON.parse(readFileSync(file, 'utf8')) as SessionFile
      writeFileSync(file, JSON.stringify(withStatus(current, status, Date.now())))
    },
    readSessionFiles() {
      return readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => ({
          file: join(sessionsDir, f),
          data: JSON.parse(readFileSync(join(sessionsDir, f), 'utf8')) as SessionFile,
        }))
    },
    fakeCliPath(provider) {
      return cliPaths[provider]
    },
    readCliLog(provider) {
      return readdirSync(logDir)
        .filter((f) => f.startsWith(`${provider}-`))
        .sort()
        .map((f) => readFileSync(join(logDir, f), 'utf8'))
        .join('')
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}
