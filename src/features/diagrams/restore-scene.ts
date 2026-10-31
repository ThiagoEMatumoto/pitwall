import type { ExcalidrawUtils } from "./excalidraw-lazy";

type RawElements = Parameters<ExcalidrawUtils["restoreElements"]>[0];

// Sem refreshDimensions: ele remede o texto com measureText na hora do restore,
// e na primeira abertura da sessão a Excalifont ainda não carregou — width e
// height encolhem para a fonte de fallback e o label sai cortado. As larguras
// já vêm certas da tabela de métricas da Excalifont (shared/excalifont-metrics.ts).
// repairBindings só refaz vínculos seta↔shape/texto↔container, não mede nada.
export const RESTORE_OPTS = { repairBindings: true } as const;

export function restoreSceneElements(
  utils: Pick<ExcalidrawUtils, "restoreElements">,
  elements: unknown,
) {
  return utils.restoreElements(elements as RawElements, null, RESTORE_OPTS);
}
