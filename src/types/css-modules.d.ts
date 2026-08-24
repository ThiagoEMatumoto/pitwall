// O exports map do @excalidraw/excalidraw expõe ./index.css só com condições
// development/production (sem "types"/"default") — o TS não resolve o subpath;
// o Vite resolve. Declaração ambiente pra destravar o import no módulo lazy.
declare module '@excalidraw/excalidraw/index.css'
