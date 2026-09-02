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
import { setPref } from '../prefs-store'
import type { MeetingEvent, MeetingSegment } from '../../../../shared/types/meetings'
import * as store from './meeting-store'
import { loadSummaryFixture } from './summary-fixture'
import {
  buildSummaryPrompt,
  EMPTY_SUMMARY,
  MY_NAME_PREF,
  myName,
  SUMMARY_MODEL_PREF,
  summarizeMeeting,
  summaryModel,
} from './summarize'

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

beforeEach(() => {
  getDb().exec(
    'DELETE FROM meeting_v2_action_items; DELETE FROM meeting_v2_segments; DELETE FROM meeting_v2_speakers; DELETE FROM meetings_v2; DELETE FROM app_prefs;',
  )
})

function seed(
  opts: {
    segments?: Array<[number, 'me' | 'them', string]>
    rawNotes?: string
  } = {},
) {
  const meeting = store.create({ title: 'Kickoff' })
  for (const [startMs, speaker, text] of opts.segments ?? []) {
    store.appendSegment({
      meetingId: meeting.id,
      speaker,
      text,
      startMs,
      endMs: startMs + 1000,
      chunkIndex: 0,
    })
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

function segment(partial: Partial<MeetingSegment> & Pick<MeetingSegment, 'id' | 'text' | 'startMs'>): MeetingSegment {
  return {
    meetingId: 'm',
    speaker: 'them',
    endMs: partial.startMs + 1000,
    chunkIndex: 0,
    createdAt: 0,
    speakerId: null,
    speakerLabel: null,
    ...partial,
  }
}

describe('buildSummaryPrompt', () => {
  it('renderiza transcript com [mm:ss] <label> e pede as seções no formato Gemini', () => {
    const prompt = buildSummaryPrompt({
      title: 'Kickoff',
      startedAt: Date.UTC(2026, 8, 2, 12, 0),
      themLabel: 'Cliente',
      rawNotes: '- [00:10] lembrar do prazo',
      speakers: [
        {
          id: 's1',
          meetingId: 'm',
          label: 'Bianca',
          voiceId: 'v1',
          turnCount: 3,
        },
        {
          id: 's2',
          meetingId: 'm',
          label: 'Participante 2',
          voiceId: null,
          turnCount: 1,
        },
      ],
      segments: [
        segment({
          id: 'a',
          text: 'Bom dia, o Pedro vai mandar o parecer',
          startMs: 65_000,
          speakerId: 's1',
          speakerLabel: 'Bianca',
        }),
        segment({ id: 'b', text: 'Olá', startMs: 70_000, speaker: 'me' }),
        segment({ id: 'c', text: 'Sem diarização', startMs: 80_000 }),
      ],
    })
    expect(prompt).toContain('[01:05] Bianca: Bom dia, o Pedro vai mandar o parecer')
    expect(prompt).toContain('[01:10] Eu: Olá')
    expect(prompt).toContain('[01:20] Cliente: Sem diarização')
    for (const section of [
      '## Participantes',
      '## Resumo',
      '## Decisões',
      '## Próximas etapas',
      '## Detalhes',
      '## Perguntas em aberto',
    ]) {
      expect(prompt).toContain(section)
    }
    expect(prompt).toContain('- Eu (eu, quem gravou)')
    expect(prompt).toContain('- Bianca (voz identificada)')
    expect(prompt).toContain('- Participante 2 (voz identificada)')
    expect(prompt).toContain('- Pedro (citado)')
    expect(prompt).toContain('"- [Dono] ação"')
    expect(prompt).toContain('> 📝')
    expect(prompt).toContain('- [00:10] lembrar do prazo')
    expect(prompt).toContain('Título: Kickoff')
    expect(prompt).not.toContain('o outro lado')
  })

  it('usa o nome do usuário no lugar de "Eu" quando informado', () => {
    const prompt = buildSummaryPrompt({
      title: 'Kickoff',
      startedAt: 0,
      themLabel: 'Participante',
      rawNotes: '',
      speakers: [],
      segments: [],
      myName: 'Thiago',
    })
    expect(prompt).toContain('- Thiago (eu, quem gravou)')
    expect(prompt).toContain('"Thiago" é quem gravou a reunião')
  })
})

describe('prefs do resumo', () => {
  it('summaryModel aceita sonnet|opus|haiku e cai pro default fora disso', () => {
    expect(summaryModel()).toBe('sonnet')
    setPref(SUMMARY_MODEL_PREF, 'opus')
    expect(summaryModel()).toBe('opus')
    setPref(SUMMARY_MODEL_PREF, 'haiku')
    expect(summaryModel()).toBe('haiku')
    setPref(SUMMARY_MODEL_PREF, 'gpt-5')
    expect(summaryModel()).toBe('sonnet')
  })

  it('myName devolve null quando vazio', () => {
    expect(myName()).toBeNull()
    setPref(MY_NAME_PREF, '  ')
    expect(myName()).toBeNull()
    setPref(MY_NAME_PREF, ' Thiago ')
    expect(myName()).toBe('Thiago')
  })
})

describe('summarizeMeeting', () => {
  it('transcript vazio e sem notas → resumo placeholder sem chamar o claude', async () => {
    const meeting = seed()
    const { runClaude } = claudeReturning('nunca')
    const events: MeetingEvent[] = []

    const out = await summarizeMeeting(meeting.id, {
      runClaude,
      emit: (e) => events.push(e),
      fixture: () => null,
    })

    expect(out.summaryMd).toBe(EMPTY_SUMMARY)
    expect(runClaude).not.toHaveBeenCalled()
    expect(events).toEqual([{ type: 'meeting', meeting: out }])
  })

  it('chama o claude com -p, modelo da pref e TEXT_ONLY_CLAUDE_ARGS, tira a cerca e persiste', async () => {
    const meeting = seed({
      segments: [[0, 'them', 'Vamos fechar o escopo até sexta']],
    })
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

  it('inclui os speakers da reunião e o nome do usuário no prompt', async () => {
    const meeting = seed({ segments: [[0, 'them', 'oi']] })
    const speaker = store.upsertSpeaker({
      meetingId: meeting.id,
      label: 'Participante 1',
      turnCount: 1,
    })
    getDb().prepare('UPDATE meeting_v2_segments SET speaker_id = ? WHERE meeting_id = ?').run(speaker.id, meeting.id)
    store.updateSegmentsSpeaker(meeting.id, speaker.id, 'Participante 1')
    setPref(MY_NAME_PREF, 'Thiago')
    const { runClaude, calls } = claudeReturning('## Resumo\nok')

    await summarizeMeeting(meeting.id, {
      runClaude,
      emit: () => {},
      fixture: () => null,
    })

    expect(calls[0][1]).toContain('- Thiago (eu, quem gravou)')
    expect(calls[0][1]).toContain('- Participante 1 (voz identificada)')
    expect(calls[0][1]).toContain('[00:00] Participante 1: oi')
  })

  it('só notas (sem segmentos) ainda gera resumo pelo claude', async () => {
    const meeting = seed({ rawNotes: '- [00:05] decidimos usar sqlite' })
    const { runClaude } = claudeReturning('## Resumo\nSQLite.')
    const out = await summarizeMeeting(meeting.id, {
      runClaude,
      emit: () => {},
      fixture: () => null,
    })
    expect(out.summaryMd).toBe('## Resumo\nSQLite.')
    expect(runClaude).toHaveBeenCalledTimes(1)
  })

  it('claude com exit != 0 → lança e não grava resumo', async () => {
    const meeting = seed({ segments: [[0, 'me', 'oi']] })
    const { runClaude } = claudeReturning('', 1)
    await expect(
      summarizeMeeting(meeting.id, {
        runClaude,
        emit: () => {},
        fixture: () => null,
      }),
    ).rejects.toThrow(/Resumo falhou/)
    expect(store.get(meeting.id)?.meeting.summaryMd).toBeNull()
  })

  it('CM_MEETING_SUMMARY_FIXTURE substitui o claude pelo JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeting-fixture-'))
    const path = join(dir, 'summary.json')
    writeFileSync(
      path,
      JSON.stringify({
        summaryMd: '## Resumo\nDa fixture.',
        actionItems: [{ title: 'Fazer X', quote: null }],
      }),
    )
    const meeting = seed({ segments: [[0, 'me', 'oi']] })
    const { runClaude } = claudeReturning('nunca')

    const fixture = loadSummaryFixture({ CM_MEETING_SUMMARY_FIXTURE: path })
    const out = await summarizeMeeting(meeting.id, {
      runClaude,
      emit: () => {},
      fixture: () => fixture,
    })

    expect(fixture).toMatchObject({
      summaryMd: '## Resumo\nDa fixture.',
      actionItems: [{ title: 'Fazer X', quote: null }],
    })
    expect(out.summaryMd).toBe('## Resumo\nDa fixture.')
    expect(out.summaryModel).toBe('fixture')
    expect(runClaude).not.toHaveBeenCalled()
    rmSync(dir, { recursive: true, force: true })
  })

  it('loadSummaryFixture sem env → null', () => {
    expect(loadSummaryFixture({})).toBeNull()
  })
})
