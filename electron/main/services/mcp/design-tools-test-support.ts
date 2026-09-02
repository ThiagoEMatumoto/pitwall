// Shared fixtures for the design_* tool tests. The electron / screenshot
// mocks stay in each test file (vi.mock is hoisted per file); everything here
// is plain code that runs after those mocks are in place.
import { designTools } from './design-tools'
import { type McpNotify, type ToolDef } from './tools'
import { applyArtboardOps } from '../design/mutate'
import type {
  ArtboardUpdatedEvent,
  DesignAgentActivity,
  DesignOp,
} from '../../../../shared/types/design'

export interface NotifySpy extends McpNotify {
  calls: Array<[string, unknown]>
}

export function makeNotify(): NotifySpy {
  const calls: Array<[string, unknown]> = []
  return {
    calls,
    broadcast: (channel, payload) => calls.push([channel, payload]),
    affectedObjectives: () => {},
    affectedObjectivesForFeatureLinks: () => {},
  }
}

export interface ToolHarness {
  notify: NotifySpy
  tools: ToolDef[]
  tool(name: string): ToolDef
  call<T>(name: string, args: unknown): Promise<T>
  activities(toolName: string): DesignAgentActivity[]
}

export function makeHarness(): ToolHarness {
  const notify = makeNotify()
  const tools = designTools(notify, { motherSessionId: 'session-mother' })
  const tool = (name: string): ToolDef => {
    const def = tools.find((t) => t.name === name)
    if (!def) throw new Error(`tool not registered: ${name}`)
    return def
  }
  return {
    notify,
    tools,
    tool,
    async call<T>(name: string, args: unknown): Promise<T> {
      const result = await tool(name).handler(args)
      return result.structuredContent as T
    },
    activities: (toolName) =>
      notify.calls
        .filter(([channel]) => channel === 'design:agent-activity')
        .map(([, payload]) => payload as DesignAgentActivity)
        .filter((a) => a.tool === toolName),
  }
}

// The IPC path (human paste) lands on the same applyArtboardOps as MCP.
export function mutateApply(input: {
  artboardId: string
  ops: DesignOp[]
  baseVersion: number
}): ArtboardUpdatedEvent {
  return applyArtboardOps({
    ...input,
    author: 'human',
    origin: { kind: 'human', sessionId: null, nonce: 'n' },
    send: () => {},
  }).event
}

export interface ArtboardMeta {
  id: string
  name: string
  width: number
  height: number
  x: number
  version: number
  rootId: string
}

export const HOME_HTML = `
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:wght@600&display=swap">
<section id="hero" style="display:flex;flex-direction:column;align-items:center;gap:24px;padding:96px 64px;background:var(--color-primary);color:#fff">
  <h1 style="font-family:'Fraunces',serif;font-size:56px;margin:0">Breads do Breno</h1>
  <p style="font-size:20px;max-width:560px;text-align:center;margin:0">Pão de fermentação natural, todo dia às 7h.</p>
  <a href="#cardapio" style="padding:14px 28px;border-radius:999px;background:#fff;color:var(--color-primary)">Ver cardápio</a>
</section>
<section id="cardapio" style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:64px">
  <div style="display:flex;flex-direction:column;gap:8px;padding:24px;border-radius:16px;background:#f6efe6">
    <h3 style="margin:0">Pão de fermentação natural</h3>
    <p style="margin:0">R$ 28</p>
  </div>
  <div style="display:flex;flex-direction:column;gap:8px;padding:24px;border-radius:16px;background:#f6efe6">
    <h3 style="margin:0">Focaccia de alecrim</h3>
    <p style="margin:0">R$ 22</p>
  </div>
</section>
<section id="sobre" style="display:flex;gap:48px;padding:64px">
  <p style="font-size:18px;line-height:1.6">O Breno acorda às 4h para a primeira fornada.</p>
</section>
<section id="contato" style="display:flex;justify-content:space-between;padding:48px 64px;background:#2b1d12;color:#fff">
  <span>Rua das Flores, 120</span>
  <a href="https://wa.me/5511999999999" style="color:#fff">WhatsApp</a>
</section>
`
