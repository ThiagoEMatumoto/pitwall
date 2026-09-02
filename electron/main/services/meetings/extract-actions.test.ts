/** @vitest-environment node */
// Extração de tarefas: grounding, criação de task no store real (tmpdir),
// item não ancorado fica proposed, JSON inválido → [] sem lançar. O claude é
// sempre mockado via deps.
import { rmSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'meeting-extract-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { app } from 'electron'
import { closeDb, getDb } from '../db'
import { TEXT_ONLY_CLAUDE_ARGS, type RunResult } from '../claude-cli'
import * as taskStore from '../task-store'
import type { MeetingEvent, MeetingSegment } from '../../../../shared/types/meetings'
import * as store from './meeting-store'
import {
  buildExtractionPrompt,
  createMeetingTask,
  extractActionItems,
  isGrounded,
  normalizeForGrounding,
  parseExtraction,
} from './extract-actions'

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

beforeEach(() => {
  getDb().exec(
    'DELETE FROM meeting_v2_action_items; DELETE FROM meeting_v2_segments; DELETE FROM meetings_v2; DELETE FROM task_links; DELETE FROM tasks;',
  )
})

function seg(text: string, speaker: 'me' | 'them' = 'them', startMs = 0): MeetingSegment {
  return { id: `s${startMs}`, meetingId: 'm', speaker, text, startMs, endMs: startMs + 1000, chunkIndex: 0, createdAt: 0 }
}

function seed(texts: string[]) {
  const meeting = store.create({ title: 'Planning' })
  texts.forEach((text, i) =>
    store.appendSegment({ meetingId: meeting.id, speaker: 'them', text, startMs: i * 1000, endMs: i * 1000 + 900, chunkIndex: 0 }),
  )
  return meeting
}

function claudeReturning(stdout: string, code = 0) {
  const calls: string[][] = []
  const runClaude = vi.fn(async (args: string[]): Promise<RunResult> => {
    calls.push(args)
    return { stdout, stderr: '', code }
  })
  return { runClaude, calls }
}

const noBroadcast = { broadcast: () => {}, emit: () => {}, fixture: () => null }

describe('isGrounded', () => {
  const segments = [seg('Então o Thiago vai enviar a proposta revisada, até sexta-feira.'), seg('Combinado, fico no aguardo.', 'me', 1000)]

  it('positivo: trecho literal', () => {
    expect(isGrounded('vai enviar a proposta revisada', segments)).toBe(true)
  })

  it('normalização: caixa, pontuação e espaços não importam', () => {
    expect(isGrounded('ENVIAR   a proposta revisada, até sexta feira', segments)).toBe(true)
    expect(normalizeForGrounding('  Olá, Mundo!!  x ')).toBe('olá mundo x')
  })

  it('cruza fronteira de segmento', () => {
    expect(isGrounded('até sexta-feira. Combinado, fico', segments)).toBe(true)
  })

  it('negativo: texto ausente, quote nula ou curta demais', () => {
    expect(isGrounded('vai enviar o contrato assinado', segments)).toBe(false)
    expect(isGrounded(null, segments)).toBe(false)
    expect(isGrounded('proposta', segments)).toBe(false)
  })
})

describe('parseExtraction', () => {
  it('aceita cerca de código e preâmbulo, descarta itens sem título e limita a 10', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `Item ${i}`, quote: 'q' }))
    expect(parseExtraction(`Segue:\n\`\`\`json\n${JSON.stringify({ items: many })}\n\`\`\``)).toHaveLength(10)
    expect(parseExtraction('{"items":[{"title":"A","quote":""},{"quote":"x"},{"title":"  "}]}')).toEqual([
      { title: 'A', quote: null },
    ])
  })

  it('JSON inválido ou sem items → []', () => {
    expect(parseExtraction('não sei')).toEqual([])
    expect(parseExtraction('{"items": "x"}')).toEqual([])
    expect(parseExtraction('{"items": [')).toEqual([])
  })
})

describe('buildExtractionPrompt', () => {
  it('pede JSON estrito e inclui o transcript renderizado', () => {
    const prompt = buildExtractionPrompt({ title: 'T', themLabel: 'Ana', rawNotes: '', segments: [seg('Vou mandar o relatório')] })
    expect(prompt).toContain('{"items":[{"title":"…","quote":"…"}]}')
    expect(prompt).toContain('{"items":[]}')
    expect(prompt).toContain('[00:00] Ana: Vou mandar o relatório')
  })
})

describe('extractActionItems', () => {
  it('item grounded cria task (origin auto, tag meeting) e vira created com taskId', async () => {
    const meeting = seed(['Eu vou enviar a proposta revisada até sexta', 'Beleza'])
    const { runClaude, calls } = claudeReturning(
      JSON.stringify({ items: [{ title: 'Enviar proposta revisada', quote: 'enviar a proposta revisada até sexta' }] }),
    )
    const broadcasts: Array<[string, unknown]> = []
    const events: MeetingEvent[] = []

    const items = await extractActionItems(meeting.id, {
      runClaude,
      model: () => 'sonnet',
      broadcast: (c, p) => broadcasts.push([c, p]),
      emit: (e) => events.push(e),
      fixture: () => null,
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ grounded: true, status: 'created', title: 'Enviar proposta revisada' })
    const task = taskStore.get(items[0].taskId!)
    expect(task).toMatchObject({ title: 'Enviar proposta revisada', origin: 'auto', tags: ['meeting'], status: 'todo', priority: 'medium' })
    expect(task?.description).toContain('Origem: reunião "Planning"')
    expect(task?.description).toContain('> enviar a proposta revisada até sexta')
    expect(broadcasts).toEqual([['task:updated', task]])
    expect(events).toEqual([{ type: 'action_items', meetingId: meeting.id, items }])
    expect(calls[0].slice(2)).toEqual(['--output-format', 'text', '--model', 'sonnet', ...TEXT_ONLY_CLAUDE_ARGS])
    expect(store.get(meeting.id)?.actionItems).toEqual(items)
  })

  it('item não grounded fica proposed e não cria task', async () => {
    const meeting = seed(['Conversa sobre o clima de hoje'])
    const { runClaude } = claudeReturning(
      JSON.stringify({ items: [{ title: 'Comprar servidor novo', quote: 'vamos comprar um servidor novo' }] }),
    )
    const items = await extractActionItems(meeting.id, { runClaude, ...noBroadcast })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ grounded: false, status: 'proposed', taskId: null })
    expect(taskStore.list()).toHaveLength(0)
  })

  it('JSON inválido → [] sem lançar', async () => {
    const meeting = seed(['Algo foi dito'])
    const { runClaude } = claudeReturning('Desculpe, não consegui.')
    await expect(extractActionItems(meeting.id, { runClaude, ...noBroadcast })).resolves.toEqual([])
    expect(store.get(meeting.id)?.actionItems).toEqual([])
  })

  it('sem transcript nem notas não chama o claude', async () => {
    const meeting = seed([])
    const { runClaude } = claudeReturning('x')
    await expect(extractActionItems(meeting.id, { runClaude, ...noBroadcast })).resolves.toEqual([])
    expect(runClaude).not.toHaveBeenCalled()
  })

  it('fixture substitui o claude mas o grounding continua valendo', async () => {
    const meeting = seed(['Vou revisar o contrato amanhã cedo'])
    const { runClaude } = claudeReturning('nunca')
    const items = await extractActionItems(meeting.id, {
      runClaude,
      broadcast: () => {},
      emit: () => {},
      fixture: () => ({
        summaryMd: '',
        actionItems: [
          { title: 'Revisar contrato', quote: 'revisar o contrato amanhã' },
          { title: 'Inventado', quote: null },
        ],
      }),
    })
    expect(runClaude).not.toHaveBeenCalled()
    expect(items.map((i) => i.status)).toEqual(['created', 'proposed'])
  })
})

describe('createMeetingTask', () => {
  it('sem quote a descrição é só a origem', () => {
    const task = createMeetingTask({ title: 'Sync', startedAt: Date.now() }, { title: 'Fazer X', quote: null }, { taskStore, broadcast: () => {} })
    expect(task.description).toMatch(/^Origem: reunião "Sync" \(/)
    expect(task.description).not.toContain('>')
  })
})
