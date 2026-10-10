import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScheduleScanner, lineSchedules } from './schedule-scan'

// Linhas no formato que o claude grava (o mesmo de chat-transcript.test.ts).
const userText = (content: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content } })
const toolUse = (name: string) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_1', name, input: {} }],
    },
  })
const assistantText = (text: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })

describe('lineSchedules', () => {
  it.each(['CronCreate', 'ScheduleWakeup', 'RemoteTrigger'])('tool_use %s agenda', (name) => {
    expect(lineSchedules(toolUse(name))).toBe(true)
  })

  it('/loop digitado agenda', () => {
    expect(
      lineSchedules(
        userText('<command-name>/loop</command-name>\n<command-args>5m /check</command-args>'),
      ),
    ).toBe(true)
  })

  it('só falar do nome da tool não agenda', () => {
    expect(lineSchedules(assistantText('Posso usar ScheduleWakeup ou CronCreate aqui.'))).toBe(
      false,
    )
    expect(lineSchedules(userText('o que faz o ScheduleWakeup?'))).toBe(false)
    expect(lineSchedules(toolUse('Bash'))).toBe(false)
  })

  it('outro slash command não agenda', () => {
    expect(lineSchedules(userText('<command-name>/model</command-name>'))).toBe(false)
  })

  it('linha com marcador que não desserializa conta como agendamento', () => {
    expect(lineSchedules('{"type":"assistant","message":{"content":[{"name":"CronCreate"')).toBe(
      true,
    )
  })
})

describe('ScheduleScanner', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'schedule-scan-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('acha o agendamento no meio de um transcript longo e cacheia por (size, mtime)', async () => {
    const path = join(dir, 's.jsonl')
    const filler = Array.from({ length: 2_000 }, (_, i) => assistantText(`linha ${i}`)).join('\n')
    writeFileSync(path, `${filler}\n${userText('oi')}\n`)
    const scanner = new ScheduleScanner()
    expect(await scanner.usedScheduling(path)).toBe(false)

    appendFileSync(path, `${toolUse('ScheduleWakeup')}\n${filler}\n`)
    expect(await scanner.usedScheduling(path)).toBe(true)
  })

  it('cache: mesmo (size, mtime) não relê', async () => {
    const path = join(dir, 's.jsonl')
    writeFileSync(path, `${userText('oi')}\n`)
    const scanner = new ScheduleScanner()
    expect(await scanner.usedScheduling(path)).toBe(false)
    // Mesmo tamanho, mesmo mtime, conteúdo diferente: prova que veio do cache.
    const same = `${userText('xy')}\n`
    writeFileSync(path, same)
    const t = new Date(Date.now() - 60_000)
    utimesSync(path, t, t)
    const fresh = await scanner.usedScheduling(path)
    expect(fresh).toBe(false)
    writeFileSync(path, `${toolUse('CronCreate')}\n`)
    utimesSync(path, t, t)
    // tamanho mudou → relê.
    expect(await scanner.usedScheduling(path)).toBe(true)
  })

  it('transcript ausente devolve null (quem chama recusa)', async () => {
    expect(await new ScheduleScanner().usedScheduling(join(dir, 'nope.jsonl'))).toBeNull()
  })
})
