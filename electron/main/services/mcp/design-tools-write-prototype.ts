// Prototype and motion writes: links between artboards and animation presets
// per node. Split from design-tools-write.ts by responsibility; same
// mutate.ts path and the same withActivity wrapper.

import * as mutate from '../design/mutate'
import { ok, type ToolDef } from './tools'
import {
  claudeOrigin,
  loadArtboard,
  schemas,
  withActivity,
  type DesignToolDeps,
} from './design-tools-shared'
import { findNode } from '../../../../shared/design/ops'

export function prototypeTools(deps: DesignToolDeps): ToolDef[] {
  const origin = () => claudeOrigin(deps)
  const base = { author: 'claude' as const, send: deps.notify.broadcast.bind(deps.notify) }

  return [
    withActivity(
      deps,
      {
        name: 'design_link_set',
        title: 'Set prototype link',
        description:
          'Make a node navigate to targetArtboardId in Preview. transition none|push|fade|smart ("smart" morphs nodes that share the same name in both artboards), optional duration (ms) and easing; null targetArtboardId removes the link. See design_guide §8 and §10.',
        inputSchema: schemas.linkSet,
        handler: (args) => {
          const input = schemas.linkSet.parse(args)
          if (input.targetArtboardId) loadArtboard(input.targetArtboardId)
          const { event } = mutate.setNodeLink({
            ...base,
            artboardId: input.artboardId,
            nodeId: input.nodeId,
            link: input.targetArtboardId
              ? {
                  artboardId: input.targetArtboardId,
                  transition: input.transition,
                  ...(input.duration !== undefined ? { duration: input.duration } : {}),
                  ...(input.easing !== undefined ? { easing: input.easing } : {}),
                }
              : null,
            origin: origin(),
          })
          return ok({
            artboardId: input.artboardId,
            version: event.version,
            nodeIds: [input.nodeId],
          })
        },
      },
      (a) => ({
        artboardId: a.artboardId as string,
        nodeIds: typeof a.nodeId === 'string' ? [a.nodeId] : [],
      }),
    ),
    withActivity(
      deps,
      {
        name: 'design_motion_set',
        title: 'Set motion presets',
        description:
          'Attach animation presets to nodes ({ id, motion: { entrance?, hover?, loop?, parallax? } | null }). Presets only — entrance fade|slide-up|slide-down|slide-left|slide-right|scale|blur (trigger load|in-view, stagger on a list animates its children), hover lift|scale|glow|color, loop pulse|marquee|float|spin, parallax { factor -1..1 }. Omitted fields take defaults; null clears. summary names the version. See design_guide §10.',
        inputSchema: schemas.motionSet,
        handler: (args) => {
          const input = schemas.motionSet.parse(args)
          const { event, artboard } = mutate.setNodeMotion({
            ...base,
            artboardId: input.artboardId,
            items: input.items,
            snapshot: input.summary !== undefined,
            summary: input.summary,
            origin: origin(),
          })
          // Echo what was stored (defaults filled, ranges clamped) so the
          // agent does not have to read the nodes back.
          const motions = Object.fromEntries(
            input.items.map((item) => [
              item.id,
              findNode(artboard.tree, item.id)?.node.motion ?? null,
            ]),
          )
          return ok({
            artboardId: input.artboardId,
            version: event.version,
            nodeIds: input.items.map((i) => i.id),
            motions,
          })
        },
      },
      (a) => ({
        artboardId: a.artboardId as string,
        nodeIds: Array.isArray(a.items) ? (a.items as Array<{ id: string }>).map((i) => i.id) : [],
      }),
    ),
  ]
}
