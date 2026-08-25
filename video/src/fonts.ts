import {
  cancelRender,
  continueRender,
  delayRender,
  staticFile,
} from "remotion";

/**
 * Familias da marca. Sao os nomes que os componentes usam em `fontFamily` —
 * batem com o `family` registrado no FontFace abaixo.
 */
export const FONT_DISPLAY = '"Schibsted Grotesk", system-ui, sans-serif';
export const FONT_MONO = '"JetBrains Mono", ui-monospace, monospace';

/**
 * Pesos REAIS disponiveis em disco. Schibsted e JetBrains aqui sao faces
 * estaticas (nao variaveis): pedir 650 faz o browser sintetizar, e a metrica do
 * texto muda em silencio. Componentes que animam peso devem ancorar nestes
 * degraus (ver snapDisplayWeight).
 */
export const DISPLAY_WEIGHTS = [400, 500, 600, 700, 800] as const;
export const MONO_WEIGHTS = [400, 700] as const;

interface FontSpec {
  family: string;
  file: string;
  weight: number;
}

// Nomes conferidos em src/assets/fonts/ (symlinkado em public/fonts).
const FONT_SPECS: FontSpec[] = [
  {
    family: "Schibsted Grotesk",
    file: "SchibstedGrotesk-Regular.woff2",
    weight: 400,
  },
  {
    family: "Schibsted Grotesk",
    file: "SchibstedGrotesk-Medium.woff2",
    weight: 500,
  },
  {
    family: "Schibsted Grotesk",
    file: "SchibstedGrotesk-SemiBold.woff2",
    weight: 600,
  },
  {
    family: "Schibsted Grotesk",
    file: "SchibstedGrotesk-Bold.woff2",
    weight: 700,
  },
  {
    family: "Schibsted Grotesk",
    file: "SchibstedGrotesk-ExtraBold.woff2",
    weight: 800,
  },
  {
    family: "JetBrains Mono",
    file: "JetBrainsMono-Regular.woff2",
    weight: 400,
  },
  { family: "JetBrains Mono", file: "JetBrainsMono-Bold.woff2", weight: 700 },
];

let loadPromise: Promise<void> | null = null;

/**
 * Carrega todas as faces da marca segurando o frame com delayRender().
 *
 * Sem o delayRender o frame 0 sai com a fonte de fallback: nao quebra o render,
 * so muda a metrica do texto — o erro mais caro possivel, porque e silencioso.
 * Idempotente: chamar N vezes registra uma vez so.
 */
export const loadPitwallFonts = (): Promise<void> => {
  if (loadPromise) return loadPromise;

  // retries: num render longo o Remotion recicla a aba a cada N frames e este
  // modulo roda de novo. Uma dessas recargas as vezes trava o fetch do woff2
  // (contencao de CPU/rede local), e sem retry a trava derruba o render inteiro
  // no meio. Com retry a aba e recarregada e o frame refeito.
  const handle = delayRender("Carregando Schibsted Grotesk + JetBrains Mono", {
    timeoutInMilliseconds: 60_000,
    retries: 3,
  });

  loadPromise = Promise.all(
    FONT_SPECS.map(async (spec) => {
      const face = new FontFace(
        spec.family,
        `url(${staticFile(`fonts/${spec.file}`)}) format('woff2')`,
        { weight: String(spec.weight), style: "normal", display: "block" },
      );
      await face.load();
      document.fonts.add(face);
    }),
  )
    .then(() => {
      continueRender(handle);
    })
    .catch((err: unknown) => {
      cancelRender(err);
    });

  return loadPromise;
};

/**
 * Ancora um peso interpolado no degrau estatico mais proximo. Animar
 * `fontWeight` de 400 a 800 num arquivo nao-variavel so produz saltos; melhor
 * saltar de proposito, nos pesos que existem, do que deixar o browser
 * sintetizar bold falso.
 */
export const snapDisplayWeight = (weight: number): number => {
  let best: number = DISPLAY_WEIGHTS[0];
  for (const w of DISPLAY_WEIGHTS) {
    if (Math.abs(w - weight) < Math.abs(best - weight)) best = w;
  }
  return best;
};

// Executa no import: qualquer modulo que toque em tipografia ja puxa as faces,
// sem depender de o componente lembrar de chamar.
loadPitwallFonts();
