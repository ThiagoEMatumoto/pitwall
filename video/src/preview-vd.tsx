// TEMPORARIO — bancada de stills das cenas voice/diagrams. Entry point avulso
// para `npx remotion still src/preview-vd.tsx <id> out.png --frame=N`, para nao
// mexer no Root.tsx enquanto outras cenas sao escritas em paralelo.
import { Composition, registerRoot, useVideoConfig } from "remotion";
import { FPS, VIDEO_HEIGHT, VIDEO_WIDTH, type Locale } from "./config";
import { getSceneTimings } from "./audio-manifest";
import { Diagrams } from "./scenes/Diagrams";
import { Voice } from "./scenes/Voice";

type PreviewProps = { locale: Locale };

const durationOf = (id: string, locale: Locale) =>
  getSceneTimings(locale).find((s) => s.id === id)!.durationInFrames;

const VoicePreview: React.FC<PreviewProps> = ({ locale }) => {
  const { durationInFrames } = useVideoConfig();
  return <Voice durationInFrames={durationInFrames} locale={locale} />;
};

const DiagramsPreview: React.FC<PreviewProps> = ({ locale }) => {
  const { durationInFrames } = useVideoConfig();
  return <Diagrams durationInFrames={durationInFrames} locale={locale} />;
};

const Root: React.FC = () => (
  <>
    <Composition
      id="Voice-pt"
      component={VoicePreview}
      defaultProps={{ locale: "pt-BR" as Locale }}
      durationInFrames={durationOf("voice", "pt-BR")}
      fps={FPS}
      width={VIDEO_WIDTH}
      height={VIDEO_HEIGHT}
    />
    <Composition
      id="Voice-en"
      component={VoicePreview}
      defaultProps={{ locale: "en" as Locale }}
      durationInFrames={durationOf("voice", "en")}
      fps={FPS}
      width={VIDEO_WIDTH}
      height={VIDEO_HEIGHT}
    />
    <Composition
      id="Diagrams-pt"
      component={DiagramsPreview}
      defaultProps={{ locale: "pt-BR" as Locale }}
      durationInFrames={durationOf("diagrams", "pt-BR")}
      fps={FPS}
      width={VIDEO_WIDTH}
      height={VIDEO_HEIGHT}
    />
    <Composition
      id="Diagrams-en"
      component={DiagramsPreview}
      defaultProps={{ locale: "en" as Locale }}
      durationInFrames={durationOf("diagrams", "en")}
      fps={FPS}
      width={VIDEO_WIDTH}
      height={VIDEO_HEIGHT}
    />
  </>
);

registerRoot(Root);
