import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Blend,
  Droplet,
  Maximize2,
  MoveHorizontal,
  Play,
  RotateCw,
  Waves,
} from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { getBridge } from '@/store/designStore'
import {
  EASINGS,
  ENTRANCE_PRESETS,
  ENTRANCE_TRIGGERS,
  HOVER_PRESETS,
  LOOP_DIRECTIONS,
  LOOP_PRESETS,
  MOTION_RANGES,
} from '@shared/design/motion'
import type { EntrancePreset, LoopPreset } from '@shared/types/design'
import { NumberField } from '../controls/NumberField'
import { Row, Section } from '../controls/Section'
import { Segmented, type SegmentedOption } from '../controls/Segmented'
import { SelectField } from '../controls/SelectField'
import { ToggleBlock } from '../controls/ToggleBlock'
import {
  EASING_LABELS,
  ENTRANCE_PRESET_LABELS,
  ENTRANCE_UI_DEFAULTS,
  HOVER_PRESET_LABELS,
  HOVER_UI_DEFAULTS,
  LOOP_DIRECTION_LABELS,
  LOOP_PRESET_LABELS,
  LOOP_UI_DEFAULTS,
  PARALLAX_UI_DEFAULTS,
  SECTION_LABELS,
  TRIGGER_LABELS,
  hasMotion,
  hasUserTransform,
  readMotionUi,
  usesDistance,
  writeMotionSection,
  type MotionSectionKey,
  type MotionUi,
} from '../motion-mapping'
import type { InspectorTarget } from '../target'

interface Props {
  target: InspectorTarget
}

export const MOTION_TESTIDS = {
  section: 'design-motion',
  replay: 'design-motion-replay',
  warning: 'design-motion-transform-warning',
  toggle: (key: MotionSectionKey) => `design-motion-toggle-${key}`,
} as const

const ENTRANCE_ICONS: Record<EntrancePreset, SegmentedOption<EntrancePreset>['icon']> = {
  fade: Blend,
  'slide-up': ArrowUp,
  'slide-down': ArrowDown,
  'slide-left': ArrowLeft,
  'slide-right': ArrowRight,
  scale: Maximize2,
  blur: Droplet,
}
const LOOP_ICONS: Record<LoopPreset, SegmentedOption<LoopPreset>['icon']> = {
  pulse: Activity,
  marquee: MoveHorizontal,
  float: Waves,
  spin: RotateCw,
}

// Seven presets across a 256px inspector: icons carry it, the tooltip names it.
const ENTRANCE_OPTIONS = ENTRANCE_PRESETS.map((p) => ({
  value: p,
  icon: ENTRANCE_ICONS[p],
  title: ENTRANCE_PRESET_LABELS[p],
}))
const TRIGGER_OPTIONS = ENTRANCE_TRIGGERS.map((t) => ({ value: t, label: TRIGGER_LABELS[t] }))
const HOVER_OPTIONS = HOVER_PRESETS.map((p) => ({ value: p, label: HOVER_PRESET_LABELS[p] }))
const LOOP_OPTIONS = LOOP_PRESETS.map((p) => ({
  value: p,
  icon: LOOP_ICONS[p],
  title: LOOP_PRESET_LABELS[p],
}))
const EASING_OPTIONS = EASINGS.map((e) => ({ value: e, label: EASING_LABELS[e] }))
const DIRECTION_OPTIONS = LOOP_DIRECTIONS.map((d) => ({
  value: d,
  label: LOOP_DIRECTION_LABELS[d],
}))

function replayMotion(artboardId: string, ids: string[]): void {
  getBridge(artboardId)?.replayMotion(ids)
}

export function MotionSection({ target }: Props) {
  const ui = readMotionUi(target.nodes[0].motion)
  const anyOn = target.nodes.some(hasMotion)
  const transformWarning = target.nodes.some(hasUserTransform)

  function write<K extends MotionSectionKey>(key: K, value: MotionUi[K] | null): void {
    const label = SECTION_LABELS[key].toLowerCase()
    target.commit(
      target.nodes.map((n) => ({
        type: 'setMotion',
        id: n.id,
        motion: writeMotionSection(n.motion, key, value),
      })),
      { summary: value ? `Animação: ${label}` : `Remove ${label}` },
    )
  }

  const entrance = ui.entrance
  const hover = ui.hover
  const loop = ui.loop
  const parallax = ui.parallax

  return (
    <Section
      title="Animação"
      defaultOpen={anyOn}
      action={
        <button
          type="button"
          data-testid={MOTION_TESTIDS.replay}
          disabled={!anyOn}
          title="Reproduzir as animações deste nó"
          onClick={() =>
            replayMotion(
              target.artboardId,
              target.nodes.map((n) => n.id),
            )
          }
          className="flex h-5 items-center gap-1 rounded px-1.5 text-[11px] text-[var(--color-text-dim)] transition hover:text-[var(--color-text)] disabled:opacity-40 disabled:hover:text-[var(--color-text-dim)]"
        >
          <Icon as={Play} size={11} />
          Reproduzir
        </button>
      }
    >
      <div data-testid={MOTION_TESTIDS.section} className="flex flex-col gap-1.5">
        {transformWarning && (
          <p
            data-testid={MOTION_TESTIDS.warning}
            className="text-[10px] leading-snug text-[var(--color-warning)]"
          >
            Este elemento tem <code>transform</code> no estilo; entrada e loop substituem esse
            valor enquanto tocam (hover e parallax se somam a ele).
          </p>
        )}

        <ToggleBlock
          label={SECTION_LABELS.entrance}
          hint={entrance ? ENTRANCE_PRESET_LABELS[entrance.preset] : undefined}
          enabled={!!entrance}
          testId={MOTION_TESTIDS.toggle('entrance')}
          onToggle={(on) => write('entrance', on ? ENTRANCE_UI_DEFAULTS : null)}
        >
          {entrance && (
            <>
              <Segmented
                value={entrance.preset}
                options={ENTRANCE_OPTIONS}
                onChange={(preset) => write('entrance', { ...entrance, preset })}
              />
              <Row label="Gatilho">
                <Segmented
                  value={entrance.trigger}
                  options={TRIGGER_OPTIONS}
                  onChange={(trigger) => write('entrance', { ...entrance, trigger })}
                />
              </Row>
              <Row label="Duração">
                <NumberField
                  value={entrance.duration}
                  unit="ms"
                  step={10}
                  min={MOTION_RANGES.duration[0]}
                  max={MOTION_RANGES.duration[1]}
                  onCommit={(v) => v != null && write('entrance', { ...entrance, duration: v })}
                />
              </Row>
              <Row label="Atraso">
                <NumberField
                  value={entrance.delay}
                  unit="ms"
                  step={10}
                  min={MOTION_RANGES.delay[0]}
                  max={MOTION_RANGES.delay[1]}
                  onCommit={(v) => v != null && write('entrance', { ...entrance, delay: v })}
                />
              </Row>
              <Row label="Easing">
                <SelectField
                  value={entrance.easing}
                  options={EASING_OPTIONS}
                  onChange={(easing) =>
                    write('entrance', { ...entrance, easing: easing as typeof entrance.easing })
                  }
                />
              </Row>
              {usesDistance(entrance.preset) && (
                <Row label="Distância">
                  <NumberField
                    value={entrance.distance}
                    min={MOTION_RANGES.distance[0]}
                    max={MOTION_RANGES.distance[1]}
                    onCommit={(v) => v != null && write('entrance', { ...entrance, distance: v })}
                  />
                </Row>
              )}
              <Row label="Stagger">
                <NumberField
                  value={entrance.stagger}
                  unit="ms"
                  step={10}
                  min={MOTION_RANGES.stagger[0]}
                  max={MOTION_RANGES.stagger[1]}
                  onCommit={(v) => v != null && write('entrance', { ...entrance, stagger: v })}
                />
              </Row>
              {entrance.stagger > 0 && (
                <p className="text-[10px] leading-snug text-[var(--color-text-dim)]">
                  Com stagger, cada filho entra em sequência em vez do próprio elemento.
                </p>
              )}
            </>
          )}
        </ToggleBlock>

        <ToggleBlock
          label={SECTION_LABELS.hover}
          hint={hover ? HOVER_PRESET_LABELS[hover.preset] : undefined}
          enabled={!!hover}
          testId={MOTION_TESTIDS.toggle('hover')}
          onToggle={(on) => write('hover', on ? HOVER_UI_DEFAULTS : null)}
        >
          {hover && (
            <>
              <Segmented
                value={hover.preset}
                options={HOVER_OPTIONS}
                onChange={(preset) => write('hover', { ...hover, preset })}
              />
              <Row label="Duração">
                <NumberField
                  value={hover.duration}
                  unit="ms"
                  step={10}
                  min={MOTION_RANGES.duration[0]}
                  max={MOTION_RANGES.duration[1]}
                  onCommit={(v) => v != null && write('hover', { ...hover, duration: v })}
                />
              </Row>
              <Row label="Easing">
                <SelectField
                  value={hover.easing}
                  options={EASING_OPTIONS}
                  onChange={(easing) =>
                    write('hover', { ...hover, easing: easing as typeof hover.easing })
                  }
                />
              </Row>
              <Row label="Intensidade">
                <NumberField
                  value={hover.intensity}
                  unit="none"
                  step={0.1}
                  min={MOTION_RANGES.intensity[0]}
                  max={MOTION_RANGES.intensity[1]}
                  onCommit={(v) => v != null && write('hover', { ...hover, intensity: v })}
                />
              </Row>
            </>
          )}
        </ToggleBlock>

        <ToggleBlock
          label={SECTION_LABELS.loop}
          hint={loop ? LOOP_PRESET_LABELS[loop.preset] : undefined}
          enabled={!!loop}
          testId={MOTION_TESTIDS.toggle('loop')}
          onToggle={(on) => write('loop', on ? LOOP_UI_DEFAULTS : null)}
        >
          {loop && (
            <>
              <Segmented
                value={loop.preset}
                options={LOOP_OPTIONS}
                onChange={(preset) => write('loop', { ...loop, preset })}
              />
              <Row label="Ciclo">
                <NumberField
                  value={loop.duration}
                  unit="ms"
                  step={100}
                  min={MOTION_RANGES.loopDuration[0]}
                  max={MOTION_RANGES.loopDuration[1]}
                  onCommit={(v) => v != null && write('loop', { ...loop, duration: v })}
                />
              </Row>
              <Row label="Direção">
                <SelectField
                  value={loop.direction}
                  options={DIRECTION_OPTIONS}
                  onChange={(direction) =>
                    write('loop', { ...loop, direction: direction as typeof loop.direction })
                  }
                />
              </Row>
            </>
          )}
        </ToggleBlock>

        <ToggleBlock
          label={SECTION_LABELS.parallax}
          hint={parallax ? `${parallax.factor}` : undefined}
          enabled={!!parallax}
          testId={MOTION_TESTIDS.toggle('parallax')}
          onToggle={(on) => write('parallax', on ? PARALLAX_UI_DEFAULTS : null)}
        >
          {parallax && (
            <Row label="Fator">
              <NumberField
                value={parallax.factor}
                unit="none"
                step={0.05}
                min={MOTION_RANGES.factor[0]}
                max={MOTION_RANGES.factor[1]}
                onCommit={(v) => v != null && write('parallax', { factor: v })}
              />
            </Row>
          )}
        </ToggleBlock>
      </div>
    </Section>
  )
}
