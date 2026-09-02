/** @vitest-environment node */
// Resumo contra store real (tmpdir) com o claude mockado via deps: nunca chama
// o binário. Cobre prompt, transcript vazio, fixture e falha do claude.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'meeting-summarize-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { app } from 'electron'
import { closeDb, getDb } from '../db'
import { TEXT_ONLY_CLAUDE_ARGS, type RunResult } from '../claude-cli'
import type { MeetingEvent } from '../../../../shared/types/meetings'
import * as store from './meeting-store'
import { loadSummaryFixture } from './summary-fixture'
import { buildSummaryPrompt, EMPTY_SUMMARY, summarizeMeeting } from './summarize'

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

beforeEach(() => {
  getDb().exec('DELETE FROM meeting_v2_action_items; DELETE FROM meeting_v2_segments; DELETE FROM meetings_v2;')
})

function seed(opts: { segments?: Array<[number, 'me' | 'them', string]>; rawNotes?: string } = {}) {
  const meeting = store.create({ title: 'Kickoff' })
  for (const [startMs, speaker, text] of opts.segments ?? []) {
    store.appendSegment({ meetingId: meeting.id, speaker, text, startMs, endMs: startMs + 1000, chunkIndex: 0 })
  }
  if (opts.rawNotes) store.update({ id: meeting.id, rawNotes: opts.rawNotes })
  return meeting
}

function claudeReturning(stdout: string, code = 0) {
  const calls: string[][] = []
  const runClaude = vi.fn(async (args: string[]): Promise<RunResult> => {
    calls.push(args)
    return { stdout, stderr: code ? 'boom' : '', code }
  })
  return { runClaude, calls }
}

describe('buildSummaryPrompt', () => {
  it('renderiza transcript com [mm:ss] Eu|<themLabel> e pede as 4 seções', () => {
    const prompt = buildSummaryPrompt({
      title: 'Kickoff',
      startedAt: Date.UTC(2026, 8, 2, 12, 0),
      themLabel: 'Cliente',
      rawNotes: '- [00:10] lembrar do prazo',
      segments: [
        { id: 'a', meetingId: 'm', speaker: 'them', text: 'Bom dia', startMs: 65_000, endMs: 66_000, chunkIndex: 0, createdAt: 0 },
        { id: 'b', meetingId: 'm', speaker: 'me', text: 'Olá', startMs: 70_000, endMs: 71_000, chunkIndex: 0, createdAt: 0 },
      ],
    })
    expect(prompt).toContain('[01:05] Cliente: Bom dia')
    expect(prompt).toContain('[01:10] Eu: Olá')
    for (const section of ['## Resumo', '## Decisões', '## Próximos passos', '## Perguntas em aberto']) {
      expect(prompt).toContain(section)
    }
    expect(prompt).toContain('> 📝')
    expect(prompt).toContain('- [00:10] lembrar do prazo')
    expect(prompt).toContain('Título: Kickoff')
  })
})

describe('summarizeMeeting', () => {
  it('transcript vazio e sem notas → resumo placeholder sem chamar o claude', async () => {
    const meeting = seed()
    const { runClaude } = claudeReturning('nunca')
    const events: MeetingEvent[] = []

    const out = await summarizeMeeting(meeting.id, { runClaude, emit: (e) => events.push(e), fixture: () => null })

    expect(out.summaryMd).toBe(EMPTY_SUMMARY)
    expect(runClaude).not.toHaveBeenCalled()
    expect(events).toEqual([{ type: 'meeting', meeting: out }])
  })

  it('chama o claude com -p, modelo da pref e TEXT_ONLY_CLAUDE_ARGS, tira a cerca e persiste', async () => {
    const meeting = seed({ segments: [[0, 'them', 'Vamos fechar o escopo até sexta']] })
    const { runClaude, calls } = claudeReturning('```markdown\n## Resumo\nFechar escopo.\n```')

    const out = await summarizeMeeting(meeting.id, {
      runClaude,
      model: () => 'opus',
      emit: () => {},
      fixture: () => null,
    })

    expect(out.summaryMd).toBe('## Resumo\nFechar escopo.')
    expect(out.summaryModel).toBe('opus')
    const args = calls[0]
    expect(args[0]).toBe('-p')
    expect(args[1]).toContain('[00:00] Participante: Vamos fechar o escopo até sexta')
    expect(args.slice(2)).toEqual(['--output-format', 'text', '--model', 'opus', ...TEXT_ONLY_CLAUDE_ARGS])
    expect(store.get(meeting.id)?.meeting.summaryMd).toBe('## Resumo\nFechar escopo.')
  })

  it('só notas (sem segmentos) ainda gera resumo pelo claude', async () => {
    const meeting = seed({ rawNotes: '- [00:05] decidimos usar sqlite' })
    const { runClaude } = claudeReturning('## Resumo\nSQLite.')
    const out = await summarizeMeeting(meeting.id, { runClaude, emit: () => {}, fixture: () => null })
    expect(out.summaryMd).toBe('## Resumo\nSQLite.')
    expect(runClaude).toHaveBeenCalledTimes(1)
  })

  it('claude com exit != 0 → lança e não grava resumo', async () => {
    const meeting = seed({ segments: [[0, 'me', 'oi']] })
    const { runClaude } = claudeReturning('', 1)
    await expect(summarizeMeeting(meeting.id, { runClaude, emit: () => {}, fixture: () => null })).rejects.toThrow(
      /Resumo falhou/,
    )
    expect(store.get(meeting.id)?.meeting.summaryMd).toBeNull()
  })

  it('CM_MEETING_SUMMARY_FIXTURE substitui o claude pelo JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeting-fixture-'))
    const path = join(dir, 'summary.json')
    writeFileSync(
      path,
      JSON.stringify({ summaryMd: '## Resumo\nDa fixture.', actionItems: [{ title: 'Fazer X', quote: null }] }),
    )
    const meeting = seed({ segments: [[0, 'me', 'oi']] })
    const { runClaude } = claudeReturning('nunca')

    const fixture = loadSummaryFixture({ CM_MEETING_SUMMARY_FIXTURE: path })
    const out = await summarizeMeeting(meeting.id, { runClaude, emit: () => {}, fixture: () => fixture })

    expect(fixture).toEqual({ summaryMd: '## Resumo\nDa fixture.', actionItems: [{ title: 'Fazer X', quote: null }] })
    expect(out.summaryMd).toBe('## Resumo\nDa fixture.')
    expect(out.summaryModel).toBe('fixture')
    expect(runClaude).not.toHaveBeenCalled()
    rmSync(dir, { recursive: true, force: true })
  })

  it('loadSummaryFixture sem env → null', () => {
    expect(loadSummaryFixture({})).toBeNull()
  })
})
