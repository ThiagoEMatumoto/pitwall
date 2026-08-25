/** @vitest-environment node */
// Unit das tools MCP do Video Lab contra um DB better-sqlite3 real (tmp dir),
// com electron mockado e o notify espiado — mesma estratégia de tools.test.ts.
// O pipeline caro (TTS/imagem/Remotion) entra pelo seam, então nenhum teste
// aqui chama API paga nem renderiza.
import { rmSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-video-tools-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { app } from 'electron'
import { closeDb } from '../db'
import { buildTools, type McpNotify, type ToolDef, type ToolResult } from './tools'
import {
  clearVideoGenerator,
  setVideoGenerator,
  type VideoGenerationPlan,
  type VideoGenerator,
} from '../video/generation-seam'
import * as templateStore from '../video/template-store'
import type { GenerateVideoAssetsResult, VideoProject } from '../../../../shared/types/ipc'

interface NotifySpy extends McpNotify {
  calls: Array<[string, unknown]>
}

function makeNotify(): NotifySpy {
  const calls: Array<[string, unknown]> = []
  return {
    calls,
    broadcast: (channel, payload) => calls.push([channel, payload]),
    affectedObjectives: () => {},
    affectedObjectivesForFeatureLinks: () => {},
  }
}

let notify: NotifySpy
let tools: ToolDef[]

function tool(name: string): ToolDef {
  const def = tools.find((t) => t.name === name)
  if (!def) throw new Error(`tool not registered: ${name}`)
  return def
}

function call<T>(name: string, args: unknown): T {
  return (tool(name).handler(args) as ToolResult).structuredContent as T
}

async function callAsync<T>(name: string, args: unknown): Promise<T> {
  const result = await tool(name).handler(args)
  return result.structuredContent as T
}

function planWith(costCents: number): VideoGenerationPlan {
  return {
    items: [{ sceneId: 'cold-open', locale: 'pt-BR', reused: false, costCents, label: 'narração' }],
    toGenerate: 1,
    reused: 0,
    estimatedCostCents: costCents,
    provider: 'elevenlabs',
    model: 'eleven_multilingual_v2',
  }
}

const EMPTY_RESULT: GenerateVideoAssetsResult = {
  assets: [],
  generated: 0,
  reused: 0,
  failed: 0,
  costCents: 0,
}

// Gerador de mentira: registra o que foi chamado. Se `generateAudio` aparecer no
// log de uma asserção de teto, o guarda de custo falhou.
function stubGenerator(plan: VideoGenerationPlan, result = EMPTY_RESULT) {
  const calls: string[] = []
  const generator: VideoGenerator = {
    planAudio: () => {
      calls.push('planAudio')
      return plan
    },
    planImage: () => {
      calls.push('planImage')
      return plan
    },
    generateAudio: async () => {
      calls.push('generateAudio')
      return result
    },
    generateImage: async () => {
      calls.push('generateImage')
      return result
    },
    startRender: () => {
      calls.push('startRender')
      throw new Error('startRender não deveria ser chamado neste teste')
    },
  }
  setVideoGenerator(generator)
  return calls
}

function seedProject(slug: string): VideoProject {
  const template = templateStore.create({
    kind: 'promo',
    name: `Template ${slug}`,
    sceneBlueprint: [{ sceneId: 'cold-open', role: 'abertura', targetSec: 4 }],
  })
  const { project } = call<{ project: VideoProject }>('video_project_create', {
    slug,
    title: 'Peça de teste',
    templateId: template.id,
    locales: ['pt-BR'],
  })
  return project
}

beforeEach(() => {
  notify = makeNotify()
  tools = buildTools(notify)
  clearVideoGenerator()
})

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

describe('mcp video tools — registro', () => {
  it('registra as tools do Video Lab e nenhuma delas é destrutiva', () => {
    const names = tools.map((t) => t.name).filter((n) => n.startsWith('video_'))
    expect(names.sort()).toEqual(
      [
        'video_asset_generate',
        'video_brand_kit_list',
        'video_brand_kit_upsert',
        'video_character_list',
        'video_character_upsert',
        'video_project_create',
        'video_project_get',
        'video_project_list',
        'video_project_update',
        'video_render',
        'video_render_list',
        'video_script_upsert',
        'video_template_create',
        'video_template_list',
      ].sort(),
    )
    expect(names.filter((n) => /delete|remove|destroy/.test(n))).toEqual([])
  })
})

describe('mcp video tools — herança de template', () => {
  it('video_project_create instancia o template (cenas + kind) e broadcasta', () => {
    const project = seedProject('promo-heranca')
    expect(project.kind).toBe('promo')
    expect(project.scenes.map((s) => s.sceneId)).toEqual(['cold-open'])
    expect(notify.calls.at(-1)?.[0]).toBe('videoProject:updated')
  })

  it('video_project_create sem template e sem kind falha com instrução, não com erro de banco', () => {
    expect(() =>
      call('video_project_create', {
        slug: 'sem-categoria',
        title: 'Sem categoria',
        locales: ['pt-BR'],
      }),
    ).toThrow(/templateId/)
  })
})

describe('mcp video tools — roteiro', () => {
  it('video_script_upsert grava o roteiro do locale e broadcasta', () => {
    const project = seedProject('promo-roteiro')
    const out = call<{ lineCount: number }>('video_script_upsert', {
      project: project.slug,
      locale: 'pt-BR',
      lines: [{ sceneId: 'cold-open', kind: 'narration', text: 'Bem-vindo ao Pitwall.' }],
    })
    expect(out.lineCount).toBe(1)
    expect(notify.calls.at(-1)).toEqual([
      'videoScript:updated',
      { projectId: project.id, locale: 'pt-BR' },
    ])
  })

  it('video_script_upsert recusa cena inexistente dizendo quais existem', () => {
    const project = seedProject('promo-cena-errada')
    expect(() =>
      call('video_script_upsert', {
        project: project.slug,
        locale: 'pt-BR',
        lines: [{ sceneId: 'nao-existe', kind: 'narration', text: 'x' }],
      }),
    ).toThrow(/cold-open/)
  })
})

describe('mcp video tools — teto de custo', () => {
  it('é dry-run por default: devolve o plano e não chama a API', async () => {
    const project = seedProject('promo-dryrun')
    const calls = stubGenerator(planWith(120))
    const out = await callAsync<{ dryRun: boolean; spentCents: number }>('video_asset_generate', {
      project: project.slug,
      mode: 'audio',
      locale: 'pt-BR',
      maxCostCents: 500,
    })
    expect(out.dryRun).toBe(true)
    expect(out.spentCents).toBe(0)
    expect(calls).toEqual(['planAudio'])
  })

  it('recusa antes de gastar quando o plano estoura maxCostCents', async () => {
    const project = seedProject('promo-estouro')
    const calls = stubGenerator(planWith(900))
    await expect(
      callAsync('video_asset_generate', {
        project: project.slug,
        mode: 'audio',
        locale: 'pt-BR',
        maxCostCents: 500,
        dryRun: false,
      }),
    ).rejects.toThrow(/exceeds maxCostCents/)
    expect(calls).toEqual(['planAudio'])
  })

  it('gera e broadcasta os assets quando o plano cabe no teto', async () => {
    const project = seedProject('promo-gera')
    const asset = {
      id: 'asset-1',
      projectId: project.id,
      sceneId: 'cold-open',
      kind: 'audio' as const,
      locale: 'pt-BR',
      path: '/tmp/a.mp3',
      hash: 'h',
      provider: 'elevenlabs',
      model: 'eleven_multilingual_v2',
      prompt: null,
      refIds: [],
      costCents: 120,
      bytes: 10,
      durationSec: 1,
      createdAt: 1,
    }
    const calls = stubGenerator(planWith(120), {
      assets: [asset],
      generated: 1,
      reused: 0,
      failed: 0,
      costCents: 120,
    })
    const out = await callAsync<{ dryRun: boolean; spentCents: number }>('video_asset_generate', {
      project: project.slug,
      mode: 'audio',
      locale: 'pt-BR',
      maxCostCents: 500,
      dryRun: false,
    })
    expect(out.dryRun).toBe(false)
    expect(out.spentCents).toBe(120)
    expect(calls).toEqual(['planAudio', 'generateAudio'])
    expect(notify.calls.at(-1)).toEqual(['videoAsset:updated', asset])
  })

  it('sem o serviço registrado, falha com mensagem legível em vez de stack de módulo', async () => {
    const project = seedProject('promo-sem-servico')
    await expect(
      callAsync('video_asset_generate', {
        project: project.slug,
        mode: 'audio',
        locale: 'pt-BR',
        maxCostCents: 500,
      }),
    ).rejects.toThrow(/generation pipeline is not available/)
  })
})
