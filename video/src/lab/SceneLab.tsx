// Bancada TEMPORARIA de stills das cenas handoff / crew-dock / outro.
// Entry point proprio (src/lab/index.ts) pra nao mexer no Root.tsx enquanto as
// outras cenas estao sendo escritas em paralelo. Apagar depois da integracao.

import { Composition, registerRoot } from "remotion";
import { getSceneTimings } from "../audio-manifest";
import { FPS, VIDEO_HEIGHT, VIDEO_WIDTH, type Locale } from "../config";
import { CrewDock } from "../scenes/CrewDock";
import { Handoff } from "../scenes/Handoff";
import { Outro } from "../scenes/Outro";

type LabProps = {
  locale: Locale;
};

const durationOf = (id: string, locale: Locale) =>
  getSceneTimings(locale).find((s) => s.id === id)!.durationInFrames;

const SCENES = [
  { id: "handoff", component: Handoff },
  { id: "crew-dock", component: CrewDock },
  { id: "outro", component: Outro },
] as const;

const Root: React.FC = () => (
  <>
    {SCENES.flatMap((scene) =>
      (["pt-BR", "en"] as Locale[]).map((locale) => {
        const Scene = scene.component;
        const duration = durationOf(scene.id, locale);
        const Wrapped: React.FC<LabProps> = (props) => (
          <Scene durationInFrames={duration} locale={props.locale} />
        );
        return (
          <Composition
            key={`${scene.id}-${locale}`}
            id={`Lab-${scene.id}-${locale === "pt-BR" ? "pt" : "en"}`}
            component={Wrapped}
            defaultProps={{ locale }}
            durationInFrames={duration}
            fps={FPS}
            width={VIDEO_WIDTH}
            height={VIDEO_HEIGHT}
          />
        );
      }),
    )}
  </>
);

registerRoot(Root);
