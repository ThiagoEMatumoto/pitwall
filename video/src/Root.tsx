import {Composition, type CalculateMetadataFunction} from 'remotion'
import {FPS, VIDEO_HEIGHT, VIDEO_WIDTH, type Locale} from './config'
import {totalDurationInFrames} from './audio-manifest'
import {MotionLab} from './MotionLab'
import {Promo, type PromoProps} from './Promo'
import {UiLab} from './UiLab'

const calculateMetadata: CalculateMetadataFunction<PromoProps> = ({props}) => ({
  durationInFrames: totalDurationInFrames(props.locale),
})

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Promo-pt-BR"
        component={Promo}
        defaultProps={{locale: 'pt-BR' as Locale}}
        calculateMetadata={calculateMetadata}
        fps={FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
      <Composition
        id="Promo-en"
        component={Promo}
        defaultProps={{locale: 'en' as Locale}}
        calculateMetadata={calculateMetadata}
        fps={FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
      {/* Banco de provas das primitivas de motion — nao entra no video final. */}
      <Composition
        id="MotionLab"
        component={MotionLab}
        durationInFrames={FPS * 10}
        fps={FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
      {/* Bancada dos componentes de chrome — não entra no vídeo final. */}
      <Composition
        id="UiLab"
        component={UiLab}
        durationInFrames={FPS * 5}
        fps={FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
    </>
  )
}
