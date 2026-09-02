/** @vitest-environment node */
// Extração de tarefas: grounding, dono → ownerKind, título com sujeito
// preservado, nada vira task por padrão (só com a pref + dono "Eu"). O claude
// é sempre mockado via deps.
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
import { setPref } from '../prefs-store'
import * as taskStore from '../task-store'
import type { MeetingEvent, MeetingSegment } from '../../../../shared/types/meetings'
import * as store from './meeting-store'
import {
  AUTO_CREATE_TASKS_PREF,
  buildExtractionPrompt,
  classifyOwner,
  createMeetingTask,
  extractActionItems,
  isGrounded,
  locateQuote,
  MY_NAME_PREF,
  normalizeForGrounding,
  parseExtraction,
  parseTimestamp,
} from './extract-actions'

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

beforeEach(() => {
  getDb().exec(
    'DELETE FROM meeting_v2_action_items; DELETE FROM meeting_v2_segments; DELETE FROM meeting_v2_speakers; DELETE FROM meetings_v2; DELETE FROM task_links; DELETE FROM tasks; DELETE FROM app_prefs;',
  )
})

function seg(text: string, speaker: 'me' | 'them' = 'them', startMs = 0, speakerLabel: string | null = null): MeetingSegment {
  return { id: `s${startMs}`, meetingId: 'm', speaker, text, startMs, endMs: startMs + 1000, chunkIndex: 0, createdAt: 0, speakerId: null, speakerLabel }
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

const quiet = { broadcast: () => {}, emit: () => {}, fixture: () => null }

describe('isGrounded / locateQuote', () => {
  const segments = [seg('Então o Thiago vai enviar a proposta revisada, até sexta-feira.'), seg('Combinado, fico no aguardo.', 'me', 1000)]

  it('positivo: trecho literal, com o startMs do segmento', () => {
    expect(isGrounded('vai enviar a proposta revisada', segments)).toBe(true)
    expect(locateQuote(segments, 'vai enviar a proposta revisada')).toBe(0)
    expect(locateQuote(segments, 'combinado, fico no aguardo')).toBe(1000)
  })

  it('normalização: caixa, pontuação e espaços não importam', () => {
    expect(isGrounded('ENVIAR   a proposta revisada, até sexta feira', segments)).toBe(true)
    expect(normalizeForGrounding('  Olá, Mundo!!  x ')).toBe('olá mundo x')
  })

  it('cruza fronteira de segmento e aponta pro segmento onde começa', () => {
    expect(isGrounded('até sexta-feira. Combinado, fico', segments)).toBe(true)
    expect(locateQuote(segments, 'até sexta-feira. Combinado, fico')).toBe(0)
  })

  it('negativo: texto ausente, quote nula ou curta demais', () => {
    expect(isGrounded('vai enviar o contrato assinado', segments)).toBe(false)
    expect(isGrounded(null, segments)).toBe(false)
    expect(isGrounded('proposta', segments)).toBe(false)
    expect(locateQuote(segments, 'proposta')).toBeNull()
  })
})

describe('classifyOwner / parseTimestamp', () => {
  it('"Eu" (qualquer caixa) e o nome do usuário → me; outro nome → named; vazio → unknown', () => {
    expect(classifyOwner('Eu', null)).toBe('me')
    expect(classifyOwner('eu', null)).toBe('me')
    expect(classifyOwner('Thiago', 'thiago')).toBe('me')
    expect(classifyOwner('Thiago', null)).toBe('named')
    expect(classifyOwner('Bianca', 'Thiago')).toBe('named')
    expect(classifyOwner(null, 'Thiago')).toBe('unknown')
    expect(classifyOwner('  ', null)).toBe('unknown')
  })

  it('mm:ss e h:mm:ss → ms; lixo → null', () => {
    expect(parseTimestamp('01:05')).toBe(65_000)
    expect(parseTimestamp('1:02:03')).toBe(3_723_000)
    expect(parseTimestamp('agora')).toBeNull()
    expect(parseTimestamp(12)).toBeNull()
  })
})

describe('parseExtraction', () => {
  it('mapeia owner → ownerKind, at → atMs e preserva o sujeito do título', () => {
    const out = parseExtraction(
      JSON.stringify({
        items: [
          { title: 'Bianca envia o PDF do caso', quote: 'q', owner: 'Bianca', at: '00:42' },
          { title: 'Revisar a petição', quote: 'q', owner: 'Eu', at: 'x' },
          { title: 'Sem dono', quote: 'q' },
        ],
      }),
    )
    expect(out).toEqual([
      { title: 'Bianca envia o PDF do caso', quote: 'q', owner: 'Bianca', ownerKind: 'named', atMs: 42_000 },
      { title: 'Revisar a petição', quote: 'q', owner: 'Eu', ownerKind: 'me', atMs: null },
      { title: 'Sem dono', quote: 'q', owner: null, ownerKind: 'unknown', atMs: null },
    ])
  })

  it('nome do usuário vira me', () => {
    const out = parseExtraction('{"items":[{"title":"T","quote":"q","owner":"Thiago"}]}', 'Thiago')
    expect(out[0].ownerKind).toBe('me')
  })

  it('aceita cerca de código e preâmbulo, descarta itens sem título e limita a 12', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ title: `Item ${i}`, quote: 'q' }))
    expect(parseExtraction(`Segue:\n\`\`\`json\n${JSON.stringify({ items: many })}\n\`\`\``)).toHaveLength(12)
    expect(parseExtraction('{"items":[{"title":"A","quote":""},{"quote":"x"},{"title":"  "}]}')).toEqual([
      { title: 'A', quote: null, owner: null, ownerKind: 'unknown', atMs: null },
    ])
  })

  it('JSON inválido ou sem items → []', () => {
    expect(parseExtraction('não sei')).toEqual([])
    expect(parseExtraction('{"items": "x"}')).toEqual([])
    expect(parseExtraction('{"items": [')).toEqual([])
  })
})

describe('buildExtractionPrompt', () => {
  it('pede JSON com owner/at, lista participantes (Eu primeiro, sem repetir) e inclui o transcript', () => {
    const prompt = buildExtractionPrompt({
      title: 'T',
      themLabel: 'Ana',
      rawNotes: '',
      participants: ['Ana', 'Bianca', 'Eu', 'Ana'],
      segments: [seg('Vou mandar o relatório')],
    })
    expect(prompt).toContain('{"items":[{"title":"…","quote":"…","owner":"…","at":"mm:ss"}]}')
    expect(prompt).toContain('{"items":[]}')
    expect(prompt).toContain('Participantes: Eu, Ana, Bianca')
    expect(prompt).toContain('mantém o sujeito')
    expect(prompt).toContain('[00:00] Ana: Vou mandar o relatório')
  })
})

describe('extractActionItems', () => {
  it('por padrão nada vira task: item grounded fica proposed com dono salvo', async () => {
    const meeting = seed(['Bianca vai enviar o PDF do caso até sexta', 'Beleza'])
    const { runClaude, calls } = claudeReturning(
      JSON.stringify({ items: [{ title: 'Bianca envia o PDF do caso', quote: 'enviar o PDF do caso até sexta', owner: 'Bianca', at: '00:00' }] }),
    )
    const events: MeetingEvent[] = []

    const items = await extractActionItems(meeting.id, {
      runClaude,
      model: () => 'sonnet',
      broadcast: () => {},
      emit: (e) => events.push(e),
      fixture: () => null,
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      grounded: true,
      status: 'proposed',
      taskId: null,
      title: 'Bianca envia o PDF do caso',
      owner: 'Bianca',
      ownerKind: 'named',
    })
    expect(taskStore.list()).toHaveLength(0)
    expect(events).toEqual([{ type: 'action_items', meetingId: meeting.id, items }])
    expect(calls[0].slice(2)).toEqual(['--output-format', 'text', '--model', 'sonnet', ...TEXT_ONLY_CLAUDE_ARGS])
    expect(store.get(meeting.id)?.actionItems).toEqual(items)
  })

  it('participantes vêm dos speakers da reunião e entram no prompt', async () => {
    const meeting = seed(['Alguém vai revisar o contrato amanhã'])
    store.upsertSpeaker({ meetingId: meeting.id, label: 'Participante 1' })
    const { runClaude, calls } = claudeReturning('{"items":[]}')
    await extractActionItems(meeting.id, { runClaude, ...quiet })
    expect(calls[0][1]).toContain('Participantes: Eu, Participante 1')
  })

  it('com a pref ligada cria task só do item grounded cujo dono é "Eu"', async () => {
    setPref(AUTO_CREATE_TASKS_PREF, true)
    const meeting = seed(['Eu vou enviar a proposta revisada até sexta', 'E a Bianca manda o PDF do caso hoje'])
    const { runClaude } = claudeReturning(
      JSON.stringify({
        items: [
          { title: 'Enviar a proposta revisada', quote: 'enviar a proposta revisada até sexta', owner: 'Eu', at: '00:00' },
          { title: 'Bianca manda o PDF do caso', quote: 'manda o PDF do caso hoje', owner: 'Bianca', at: '00:01' },
          { title: 'Inventado', quote: 'nunca dito nesta reunião', owner: 'Eu' },
        ],
      }),
    )
    const broadcasts: Array<[string, unknown]> = []
    const items = await extractActionItems(meeting.id, { runClaude, broadcast: (c, p) => broadcasts.push([c, p]), emit: () => {}, fixture: () => null })

    expect(items.map((i) => [i.status, i.ownerKind, i.grounded])).toEqual([
      ['created', 'me', true],
      ['proposed', 'named', true],
      ['proposed', 'me', false],
    ])
    const task = taskStore.get(items[0].taskId!)
    expect(task).toMatchObject({ title: 'Enviar a proposta revisada', origin: 'auto', tags: ['meeting'], status: 'todo', priority: 'medium' })
    expect(task?.description).toContain('Origem: reunião "Planning"')
    expect(task?.description).toContain('· 00:00')
    expect(task?.description).toContain('> enviar a proposta revisada até sexta')
    expect(broadcasts).toEqual([['task:updated', task]])
    expect(taskStore.list()).toHaveLength(1)
  })

  it('pref ligada + nome do usuário: o nome conta como "Eu"', async () => {
    setPref(AUTO_CREATE_TASKS_PREF, true)
    setPref(MY_NAME_PREF, 'Thiago')
    const meeting = seed(['Thiago fica de revisar o contrato amanhã cedo'])
    const { runClaude } = claudeReturning(
      JSON.stringify({ items: [{ title: 'Thiago revisa o contrato', quote: 'revisar o contrato amanhã cedo', owner: 'Thiago' }] }),
    )
    const items = await extractActionItems(meeting.id, { runClaude, ...quiet })
    expect(items[0]).toMatchObject({ ownerKind: 'me', status: 'created' })
    expect(taskStore.get(items[0].taskId!)?.title).toBe('Thiago revisa o contrato')
  })

  it('item não grounded fica proposed sem task', async () => {
    const meeting = seed(['Conversa sobre o clima de hoje'])
    const { runClaude } = claudeReturning(
      JSON.stringify({ items: [{ title: 'Comprar servidor novo', quote: 'vamos comprar um servidor novo' }] }),
    )
    const items = await extractActionItems(meeting.id, { runClaude, ...quiet })
    expect(items[0]).toMatchObject({ grounded: false, status: 'proposed', taskId: null, ownerKind: 'unknown' })
    expect(taskStore.list()).toHaveLength(0)
  })

  it('JSON inválido → [] sem lançar', async () => {
    const meeting = seed(['Algo foi dito'])
    const { runClaude } = claudeReturning('Desculpe, não consegui.')
    await expect(extractActionItems(meeting.id, { runClaude, ...quiet })).resolves.toEqual([])
    expect(store.get(meeting.id)?.actionItems).toEqual([])
  })

  it('sem transcript nem notas não chama o claude', async () => {
    const meeting = seed([])
    const { runClaude } = claudeReturning('x')
    await expect(extractActionItems(meeting.id, { runClaude, ...quiet })).resolves.toEqual([])
    expect(runClaude).not.toHaveBeenCalled()
  })

  it('fixture substitui o claude; owner é classificado e o grounding continua valendo', async () => {
    const meeting = seed(['Vou revisar o contrato amanhã cedo'])
    const { runClaude } = claudeReturning('nunca')
    const items = await extractActionItems(meeting.id, {
      runClaude,
      broadcast: () => {},
      emit: () => {},
      fixture: () => ({
        summaryMd: '',
        actionItems: [
          { title: 'Revisar contrato', quote: 'revisar o contrato amanhã', owner: 'Eu', atMs: 0 },
          { title: 'Inventado', quote: null, owner: null, atMs: null },
        ],
      }),
    })
    expect(runClaude).not.toHaveBeenCalled()
    expect(items.map((i) => [i.status, i.grounded, i.ownerKind])).toEqual([
      ['proposed', true, 'me'],
      ['proposed', false, 'unknown'],
    ])
    expect(taskStore.list()).toHaveLength(0)
  })
})

describe('createMeetingTask', () => {
  const meeting = { title: 'Sync', startedAt: Date.now() }

  it('dono que não é o usuário vai pro título; quote e timestamp na descrição', () => {
    const task = createMeetingTask(
      meeting,
      { title: 'Enviar o PDF', quote: 'manda o PDF hoje', owner: 'Bianca', ownerKind: 'named', atMs: 65_000 },
      { taskStore, broadcast: () => {} },
    )
    expect(task.title).toBe('[Bianca] Enviar o PDF')
    expect(task.description).toMatch(/^Origem: reunião "Sync" \(.+\) · 01:05\n\n> manda o PDF hoje$/)
  })

  it('dono "Eu" não prefixa; sem quote a descrição é só a origem', () => {
    const task = createMeetingTask(meeting, { title: 'Fazer X', quote: null, owner: 'Eu', ownerKind: 'me', atMs: null }, { taskStore, broadcast: () => {} })
    expect(task.title).toBe('Fazer X')
    expect(task.description).toMatch(/^Origem: reunião "Sync" \(/)
    expect(task.description).not.toContain('>')
  })
})
