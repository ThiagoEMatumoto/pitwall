// design_* MCP tools — Design Studio for the agent. Registered by buildTools()
// in tools.ts with one spread; reads in design-tools-read.ts, writes in
// design-tools-write.ts, the guide in design-guide.ts.

import * as designStore from '../design/design-store'
import * as liveState from '../design/live-state'
import * as mutate from '../design/mutate'
import { exportArtboardHtml, exportArtboardJsx, exportArtboardPng } from '../design/export'
import { ok, type McpNotify, type McpRequestContext, type ToolDef } from './tools'
import { readTools } from './design-tools-read'
import { writeTools } from './design-tools-write'
import { DESIGN_GUIDE, guideSection } from './design-guide'
import { claudeOrigin, loadArtboard, schemas, type DesignToolDeps } from './design-tools-shared'
import type { DesignAgentActivity } from '../../../../shared/types/design'

export { withActivity } from './design-tools-shared'

function utilTools(deps: DesignToolDeps): ToolDef[] {
  return [
    {
      name: 'design_export',
      title: 'Export artboard',
      description:
        'Export one artboard: "html" (standalone, assets inlined), "jsx" (React component with inline styles) or "png" (base64, scale 1|2). See design_guide §6.',
      inputSchema: schemas.export,
      handler: async (args) => {
        const { artboardId, format, scale } = schemas.export.parse(args)
        if (format === 'png') {
          const png = await exportArtboardPng({ artboardId, scale })
          return ok({ artboardId, format, ...png })
        }
        const text =
          format === 'jsx' ? exportArtboardJsx(artboardId) : exportArtboardHtml(artboardId)
        return ok({ artboardId, format, ...text })
      },
    },
    {
      name: 'design_guide',
      title: 'Design Studio guide',
      description:
        'READ FIRST. How to work in the Design Studio: required flow, model, which tool for which edit, accepted HTML, tokens/fonts, assets, self-correction, prototype links, common mistakes. Optional section 1-10.',
      inputSchema: schemas.guide,
      handler: (args) => {
        const { section } = schemas.guide.parse(args)
        if (section === undefined) return ok({ guide: DESIGN_GUIDE })
        const text = guideSection(section)
        if (!text) throw new Error(`design_guide: no section ${section}`)
        return ok({ section, guide: text })
      },
    },
    {
      name: 'design_nodes_finish',
      title: 'Finish editing',
      description:
        'Call when an artboard is done: clears the "Claude is editing" badge and records a named version (summary). Always the last design_* call for an artboard. See design_guide §1.',
      inputSchema: schemas.nodesFinish,
      handler: (args) => {
        const input = schemas.nodesFinish.parse(args)
        const { artboard, docId } = loadArtboard(input.artboardId)
        liveState.clearActivity(docId, { artboardId: input.artboardId })

        // A snapshot at the current head is only worth recording once.
        const head = designStore.listVersions(input.artboardId)[0]
        const alreadySnapshotted = head?.version === artboard.version
        const version = alreadySnapshotted
          ? artboard.version
          : mutate.applyArtboardOps({
              artboardId: input.artboardId,
              ops: [],
              author: 'claude',
              origin: claudeOrigin(deps),
              snapshot: true,
              summary: input.summary ?? `Claude: ${artboard.name}`,
              send: deps.notify.broadcast.bind(deps.notify),
            }).event.version

        const activity: DesignAgentActivity = {
          docId,
          artboardId: input.artboardId,
          nodeIds: input.ids ?? [],
          tool: 'design_nodes_finish',
          phase: 'finish',
          sessionId: deps.ctx.motherSessionId,
          at: Date.now(),
          summary: input.summary,
        }
        deps.notify.broadcast('design:agent-activity', activity)
        return ok({
          artboardId: input.artboardId,
          version,
          snapshotted: !alreadySnapshotted,
        })
      },
    },
  ]
}

export function designTools(notify: McpNotify, ctx: McpRequestContext): ToolDef[] {
  const deps: DesignToolDeps = { notify, ctx }
  return [...readTools(deps), ...writeTools(deps), ...utilTools(deps)]
}
