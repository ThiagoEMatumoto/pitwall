// Grupos e frames: nós compostos. No ELK viram compound nodes; na cena, a
// caixa (retângulo tracejado ou frame do Excalidraw) sempre envolve os
// filhos com o mesmo padding que o ELK reservou. A pertença na cena vem de
// groupIds (grupo) e frameId (frame) — o mesmo que o editor mantém.
import type {
  Box,
  DiagramSkeletonElement,
  ExElement,
} from "./diagram-skeleton";

export type CompoundKind = "group" | "frame";

export const isCompoundType = (type: string): type is CompoundKind =>
  type === "group" || type === "frame";

export function compoundKind(el: {
  customData?: Record<string, unknown>;
}): CompoundKind | undefined {
  const kind = (el.customData?.pitwall as { kind?: unknown } | undefined)?.kind;
  return kind === "group" || kind === "frame" ? kind : undefined;
}

export const isCompoundElement = (el: ExElement) =>
  !el.isDeleted && compoundKind(el) !== undefined;

export interface Padding {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** Grupo com label reserva o topo pro texto; o nome do frame fica fora da caixa. */
export function compoundPadding(
  kind: CompoundKind,
  hasLabel: boolean,
): Padding {
  const top = kind === "group" && hasLabel ? 44 : 24;
  return { top, left: 24, bottom: 24, right: 24 };
}

export const EMPTY_COMPOUND_SIZE = { width: 240, height: 140 };

/**
 * Pai de cada filho declarado no skeleton. O primeiro compound que reclama um
 * filho vence; filho inexistente, seta ou ciclo é ignorado.
 */
export function skeletonParents(
  skeleton: DiagramSkeletonElement[],
): Map<string, string> {
  const byId = new Map(skeleton.map((s) => [s.id, s]));
  const parent = new Map<string, string>();
  for (const s of skeleton) {
    if (!isCompoundType(s.type)) continue;
    for (const childId of s.children ?? []) {
      const child = byId.get(childId);
      if (!child || childId === s.id || parent.has(childId)) continue;
      if (child.type === "arrow" || child.type === "line") continue;
      let cycle = false;
      for (
        let a: string | undefined = s.id;
        a !== undefined;
        a = parent.get(a)
      ) {
        if (a === childId) {
          cycle = true;
          break;
        }
      }
      if (!cycle) parent.set(childId, s.id);
    }
  }
  return parent;
}

/**
 * Pai de cada elemento vivo da cena. Candidatos = compounds em groupIds mais o
 * frameId; o pai é o mais profundo (o que tem mais compounds acima dele), o
 * que acerta tanto grupo-dentro-de-frame quanto frame-dentro-de-grupo.
 */
export function sceneParents(
  elements: readonly ExElement[],
): Map<string, string> {
  const compounds = new Map(
    elements.filter(isCompoundElement).map((el) => [el.id, el]),
  );
  const candidates = (el: ExElement) => {
    const out = (el.groupIds ?? []).filter(
      (g) => g !== el.id && compounds.has(g),
    );
    if (
      el.frameId &&
      el.frameId !== el.id &&
      compounds.has(el.frameId) &&
      !out.includes(el.frameId)
    ) {
      out.push(el.frameId);
    }
    return out;
  };
  const depth = new Map(
    [...compounds].map(([id, el]) => [id, candidates(el).length]),
  );
  const parents = new Map<string, string>();
  for (const el of elements) {
    if (el.isDeleted) continue;
    const list = candidates(el);
    if (list.length === 0) continue;
    parents.set(
      el.id,
      list.reduce((best, c) => (depth.get(c)! > depth.get(best)! ? c : best)),
    );
  }
  return parents;
}

/** groupIds (interno → externo) e frameId que um nó herda dos ancestrais. */
export function membershipFor(
  id: string,
  parents: ReadonlyMap<string, string>,
  kindOf: (id: string) => CompoundKind | undefined,
): { groupIds: string[]; frameId: string | null } {
  const groupIds: string[] = [];
  let frameId: string | null = null;
  for (let a = parents.get(id); a !== undefined; a = parents.get(a)) {
    const kind = kindOf(a);
    if (kind === "group") groupIds.push(a);
    else if (kind === "frame" && frameId === null) frameId = a;
  }
  return { groupIds, frameId };
}

/** Caixa que envolve os membros com o padding do compound. */
export function fitBox(members: readonly Box[], pad: Padding): Box {
  const minX = Math.min(...members.map((m) => m.x));
  const minY = Math.min(...members.map((m) => m.y));
  const maxX = Math.max(...members.map((m) => m.x + m.width));
  const maxY = Math.max(...members.map((m) => m.y + m.height));
  return {
    x: minX - pad.left,
    y: minY - pad.top,
    width: maxX - minX + pad.left + pad.right,
    height: maxY - minY + pad.top + pad.bottom,
  };
}

/** Compounds do mais profundo pro mais externo (filhos se ajustam antes). */
export function deepestFirst(
  ids: readonly string[],
  parents: ReadonlyMap<string, string>,
): string[] {
  const depthOf = (id: string) => {
    let d = 0;
    for (let a = parents.get(id); a !== undefined; a = parents.get(a)) d++;
    return d;
  };
  return [...ids].sort((a, b) => depthOf(b) - depthOf(a));
}
