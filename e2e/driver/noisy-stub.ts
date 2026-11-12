// O stub do `claude` das medições de desempenho e a leitura da carga que ele põe
// na tela.

function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

// Stub vivo: grava o session file como 'idle', ecoa o stdin e, enquanto o arquivo
// `noiseFlag` existir, emite ~5 linhas de saída por segundo (carga de pty:data sem
// passar por nenhum IPC do renderer, que sujaria a contagem de sessions:write).
export function noisyStub(sessionsDir: string, logDir: string, noiseFlag: string): string {
  const rule = '─'.repeat(50)
  const filler = 'lorem ipsum dolor sit amet consectetur '.repeat(2)
  return `#!/usr/bin/env bash
SESSIONS_DIR=${shq(sessionsDir)}
LOG=${shq(logDir)}/claude-$$.log
NOISE=${shq(noiseFlag)}
printf 'argv:' >> "$LOG"; for a in "$@"; do printf ' %q' "$a" >> "$LOG"; done; printf '\\n' >> "$LOG"
session_id=''; name=''
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id|--resume) session_id="$2"; shift 2 ;;
    -n|--name) name="$2"; shift 2 ;;
    *) shift ;;
  esac
done
now=$(date +%s%3N)
printf '{"pid":%s,"sessionId":"%s","cwd":"%s","status":"idle","name":"%s","startedAt":%s,"updatedAt":%s}' \\
  "$$" "$session_id" "$PWD" "$name" "$now" "$now" > "$SESSIONS_DIR/$$.json"
box() { printf '\\n%s\\n\\u276f \\n%s\\n' ${shq(rule)} ${shq(rule)}; }
printf '\\u23fa Fake Claude Code (stub perf) %s\\n' "$name"
box
n=0
while true; do
  if IFS= read -t 0.2 -r line; then
    printf '\\u23fa recebido: %s\\n' "$line"
    box
  elif [ $? -le 128 ]; then
    exit 0
  elif [ -e "$NOISE" ]; then
    n=$((n+1))
    printf '\\u23fa saida %s %s\\n' "$n" ${shq(filler)}
  fi
done
`
}

// Uma saída de carga do stub; o número é o contador dele, que só cresce.
const NOISE_OUTPUT = /\u23fa saida (\d+) /g

/**
 * O número da última saída de carga no texto de um xterm (0 sem nenhuma). A
 * diferença entre duas leituras da mesma sessão é quantas saídas ela pôs na tela.
 */
export function lastNoiseOutput(screen: string): number {
  let last = 0
  for (const output of screen.matchAll(NOISE_OUTPUT)) last = Number(output[1])
  return last
}
