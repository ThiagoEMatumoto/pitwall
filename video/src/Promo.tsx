import {AbsoluteFill, Series} from 'remotion'
import {getSceneTimings} from './audio-manifest'
import type {Locale} from './config'
import {FONT_MONO} from './fonts'
import {tokens} from './theme'

// Type alias, nao interface: o generic Props do <Composition> exige compatibilidade
// com Record<string, unknown>, que interfaces nao satisfazem (sem index signature).
export type PromoProps = {
  locale: Locale
}

const ScenePlaceholder: React.FC<{id: string; durationInFrames: number}> = ({
  id,
  durationInFrames,
}) => {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: tokens.bg,
        color: tokens.text,
        fontFamily: FONT_MONO,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
      }}
    >
      <div style={{fontSize: 96, letterSpacing: -2}}>{id}</div>
      <div style={{fontSize: 32, color: tokens['text-dim']}}>{durationInFrames} frames</div>
    </AbsoluteFill>
  )
}

export const Promo: React.FC<PromoProps> = ({locale}) => {
  const scenes = getSceneTimings(locale)

  return (
    <AbsoluteFill style={{backgroundColor: tokens.bg}}>
      <Series>
        {scenes.map((scene) => (
          <Series.Sequence
            key={scene.id}
            durationInFrames={scene.durationInFrames}
            name={scene.id}
          >
            <ScenePlaceholder id={scene.id} durationInFrames={scene.durationInFrames} />
          </Series.Sequence>
        ))}
      </Series>
    </AbsoluteFill>
  )
}
