// Status working/idle de quem NÃO tem índice nativo de status (o claude grava
// ~/.claude/sessions/<pid>.json; o Codex não grava nada equivalente). A única
// fonte é a própria saída da PTY: a tela mudou de verdade nos últimos
// PTY_IDLE_MS → trabalhando; parou → ocioso. Módulo PURO.
//
// "Mudou de verdade" é medido sobre o tail VISÍVEL normalizado, não sobre bytes:
// um spinner redesenha a mesma linha várias vezes por segundo trocando só um
// glifo, e contar isso como trabalho deixaria a sessão "trabalhando" para sempre.
// O contador de segundos do "Working (12s)" muda o texto e conta — e é trabalho.
import { createHash } from 'node:crypto'
import type { LiveStatus } from '../../../../shared/tui/attention-reason'

export const PTY_IDLE_MS = 2_000
// Bytes do fim do backlog considerados: sobra para TAIL_LINES linhas largas.
export const PTY_TAIL_WINDOW = 8 * 1024
const TAIL_LINES = 12

// CSI (cores, cursor, clear-line), OSC (título da janela) e escapes de 2 bytes.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
// Glifos de spinner comuns: braille (⠋⠙…), quartos de círculo, estrelas do
// claude e bullets que piscam. ASCII (|/-\) fica fora: é texto de verdade.
const SPINNER_RE = /[⠀-⣿◐◓◑◒◴◵◶◷✢✳✶✻✽·•◦●○]/g

export interface PtySample {
  lastByteAt: number | null
  tailHash: string | null
  // Quando o tail visível normalizado mudou pela última vez.
  hashChangedAt: number | null
}

// Aproximação barata da tela sem um emulador: tira os escapes, aplica o \r como
// sobrescrita da linha e fica com as últimas linhas não vazias.
export function visibleTail(raw: string): string {
  const lines = raw
    .replace(ANSI_RE, '')
    .split('\n')
    // O \r do CRLF não é sobrescrita: sai antes de procurar o último \r.
    .map((line) => line.replace(/\r+$/, ''))
    .map((line) => line.slice(line.lastIndexOf('\r') + 1).trimEnd())
    .filter((line) => line.length > 0)
  return lines.slice(-TAIL_LINES).join('\n')
}

export function tailSignature(visible: string): string {
  return createHash('sha1').update(visible.replace(SPINNER_RE, '*')).digest('hex')
}

// echo: o chunk veio logo depois de uma escrita/resize do app (eco da tecla,
// reflow) — o tail muda, mas não é o agente trabalhando.
export function nextPtySample(
  prev: PtySample,
  backlog: string,
  now: number,
  opts: { echo?: boolean } = {},
): PtySample {
  const hash = tailSignature(visibleTail(backlog.slice(-PTY_TAIL_WINDOW)))
  const changed = hash !== prev.tailHash && !(opts.echo && prev.hashChangedAt !== null)
  return {
    lastByteAt: now,
    tailHash: hash,
    hashChangedAt: changed ? now : prev.hashChangedAt,
  }
}

export function derivePtyStatus(sample: PtySample, now: number): LiveStatus {
  if (sample.lastByteAt === null || sample.hashChangedAt === null) return 'starting'
  return now - sample.hashChangedAt < PTY_IDLE_MS ? 'working' : 'idle'
}
