import { Composition, type CalculateMetadataFunction } from "remotion";
import { FPS, VIDEO_HEIGHT, VIDEO_WIDTH, type Locale } from "./config";
import { Promo, promoDurationInFrames, type PromoProps } from "./Promo";

// A duracao vem do Promo, nao do manifesto cru: as sobreposicoes entre cenas
// encurtam o filme, e uma composicao mais longa que o corte deixaria cauda preta.
const calculateMetadata: CalculateMetadataFunction<PromoProps> = ({
  props,
}) => ({
  durationInFrames: promoDurationInFrames(props.locale),
});

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Promo-pt-BR"
        component={Promo}
        defaultProps={{ locale: "pt-BR" as Locale }}
        calculateMetadata={calculateMetadata}
        fps={FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
      <Composition
        id="Promo-en"
        component={Promo}
        defaultProps={{ locale: "en" as Locale }}
        calculateMetadata={calculateMetadata}
        fps={FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
    </>
  );
};
