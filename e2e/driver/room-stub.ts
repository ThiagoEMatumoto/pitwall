import { chmodSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FakeHome } from './fake-home'

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
const RULE = '─'.repeat(50)

// Stub do claude dos cenários da Room (room-mother, room-mothers). Lê byte a byte
// (raw). Enter fecha a linha: loga, grava user+assistant no
// transcript (~/.claude/projects/<cwd>/<session>.jsonl, o que o chat lê) e redesenha
// a caixa ociosa. "PEDE-PERMISSAO" desenha a captura REAL do menu de permissão; aí
// um dígito responde e grava "PERMISSAO-RESPONDIDA <n>".
// Um log por PID em $logDir/room-claude-<pid>.log, com o argv na 1ª linha.
export function writeRoomClaudeStub(fake: FakeHome, permissionFixture: string): string {
  const stubPath = join(fake.root, 'bin', 'room-mother-claude.sh')
  writeFileSync(
    stubPath,
    `#!/usr/bin/env bash
export LC_ALL=C
SESSIONS_DIR=${shq(fake.sessionsDir)}
LOG=${shq(fake.logDir)}/room-claude-$$.log
FIXTURE=${shq(permissionFixture)}
printf 'argv:' >> "$LOG"; for a in "$@"; do printf ' %q' "$a" >> "$LOG"; done; printf '\\n' >> "$LOG"
session_id=''; name=''
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id|--resume) session_id="$2"; shift 2 ;;
    -n|--name) name="$2"; shift 2 ;;
    *) shift ;;
  esac
done
json_str() { local s=\${1//\\\\/\\\\\\\\}; s=\${s//\\"/\\\\\\"}; printf '"%s"' "$s"; }
write_status() {
  local now; now=$(date +%s%3N)
  printf '{"pid":%s,"sessionId":%s,"cwd":%s,"status":"%s","name":%s,"startedAt":%s,"updatedAt":%s}' \\
    "$$" "$(json_str "$session_id")" "$(json_str "$PWD")" "$1" "$(json_str "$name")" "$now" "$now" > "$SESSIONS_DIR/$$.json"
  printf 'status:%s\\n' "$1" >> "$LOG"
}
PROJ="$HOME/.claude/projects/\${PWD//[\\/.]/-}"
mkdir -p "$PROJ"
TR="$PROJ/$session_id.jsonl"
n=0
rec() { # role text
  n=$((n+1)); local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
  if [ "$1" = user ]; then
    printf '{"type":"user","uuid":"u-%s-%s","sessionId":"%s","timestamp":"%s","message":{"role":"user","content":%s}}\\n' "$$" "$n" "$session_id" "$ts" "$(json_str "$2")" >> "$TR"
  else
    printf '{"type":"assistant","uuid":"a-%s-%s","sessionId":"%s","timestamp":"%s","message":{"id":"m-%s-%s","role":"assistant","model":"claude-e2e","content":[{"type":"text","text":%s}]}}\\n' "$$" "$n" "$session_id" "$ts" "$$" "$n" "$(json_str "$2")" >> "$TR"
  fi
}
box() { printf '\\r\\n%s\\r\\n❯ \\r\\n%s\\r\\n' ${shq(RULE)} ${shq(RULE)}; }
stty raw -echo
printf 'Fake Claude Code (stub B1)\\r\\n  sessao: %s\\r\\n  nome:   %s\\r\\n' "$session_id" "$name"
box
write_status idle
menu=0; esc=0; buf=''
while true; do
  if IFS= read -r -s -n1 -d '' ch; then
    printf 'key:%02x\\n' "'$ch" >> "$LOG"
    if [ $esc -eq 1 ]; then
      case "$ch" in [A-Za-z~]) esc=0 ;; esac
      continue
    fi
    if [ "$ch" = $'\\e' ]; then
      IFS= read -r -s -n1 -d '' -t 0.05 nx || { buf+="$ch"; continue; }
      if [ "$nx" = '[' ]; then esc=1; continue; fi
      if [ "$nx" = 'O' ]; then IFS= read -r -s -n1 -d '' -t 0.05 _; fi
      continue
    fi
    if [ $menu -eq 1 ]; then
      case "$ch" in
        [1-9]) menu=0; printf '\\033[2J\\033[H* respondido %s\\r\\n' "$ch"; printf 'menu-answer:%s\\n' "$ch" >> "$LOG"
               rec assistant "PERMISSAO-RESPONDIDA $ch"; box; write_status idle ;;
      esac
      continue
    fi
    if [ "$ch" = $'\\r' ] || [ "$ch" = $'\\n' ]; then
      line=$buf; buf=''
      [ -z "$line" ] && continue
      printf 'line:%s\\n' "$line" >> "$LOG"
      printf '\\r\\nrecebido: %s\\r\\n' "$line"
      rec user "$line"
      if [[ "$line" == *PEDE-PERMISSAO* ]]; then
        rec assistant "vou pedir permissao"
        printf '\\033[2J\\033[3J\\033[H'; cat "$FIXTURE"; menu=1; write_status waiting
      else
        rec assistant "RESPOSTA-MAE: $line"; box; write_status idle
      fi
    else
      buf+="$ch"
    fi
  elif [ $? -le 128 ]; then
    exit 0
  fi
done
`,
  )
  chmodSync(stubPath, 0o755)
  return stubPath
}

export interface RoomStubLog {
  file: string
  text: string
}

export function roomStubLogs(fake: FakeHome): RoomStubLog[] {
  return readdirSync(fake.logDir)
    .filter((f) => f.startsWith('room-claude-'))
    .map((f) => ({ file: f, text: readFileSync(join(fake.logDir, f), 'utf8') }))
}
