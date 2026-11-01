// Patch incremental sobre a cena Excalidraw vigente. Síncrono e isomórfico:
// o layout (ELK) é calculado fora (electron/main/services/diagram-layout.ts)
// e entra em finalizePatchLayout.
import {
  buildElements,
  centeredIn,
  directionOf,
  elbowGeometry,
  fractionalIndexAt,
  isAutoPlaced,
  isLayoutNode,
  makeTextElement,
  labelIdFor,
  polylineMidpoint,
  selfLoopRoute,
  randInt,
  sizeFor,
  textMetrics,
  withPitwallMeta,
  type Box,
  type DiagramDirection,
  type DiagramPatchOp,
  type DiagramSkeletonElement,
  type DiagramSkeletonElementType,
  type ExBase,
  type ExElement,
  type ExLinear,
  type ExText,
  type LayoutResult,
  type Point,
  textAsLabel,
} from "./diagram-skeleton";
import {
  avoidingRoute,
  pointOnBorder,
  routeCrossings,
  withArrowheadStubs,
} from "./diagram-route";
import {
  blockKind,
  bindingTargetResolver,
  blockToSkeleton,
  boundTextPosition,
  buildBlock,
  partOwner,
  RELATION_ARROWHEADS,
} from "./diagram-shapes";
import {
  compoundKind,
  compoundPadding,
  deepestFirst,
  fitBox,
  isCompoundElement,
  isCompoundType,
  sceneParents,
} from "./diagram-compound";

const GRID_GAP = 80;
// Distância base pra posicionar nós novos de patch e margem anti-colisão.
const PATCH_ADD_GAP = 120;
const COLLISION_MARGIN = 40;
const BINDING_GAP = 4;

const EMPTY_LAYOUT: LayoutResult = { positions: new Map(), routes: new Map() };

function bump<T extends ExElement>(el: T, changes: Partial<T>): T {
  return {
    ...el,
    ...changes,
    version: el.version + 1,
    versionNonce: randInt(),
    updated: Date.now(),
  };
}

const isSolid = (el: ExElement) =>
  !el.isDeleted && el.type !== "arrow" && el.type !== "line";

function collides(box: Box, solids: readonly Box[]): boolean {
  return solids.some(
    (o) =>
      box.x < o.x + o.width + COLLISION_MARGIN &&
      o.x < box.x + box.width + COLLISION_MARGIN &&
      box.y < o.y + o.height + COLLISION_MARGIN &&
      o.y < box.y + box.height + COLLISION_MARGIN,
  );
}

/** Nó existente ligado ao novo nó por uma seta adicionada no mesmo patch. */
function findLinkAnchor(
  nodeId: string,
  ops: DiagramPatchOp[],
  solids: ExElement[],
): ExElement | undefined {
  for (const op of ops) {
    if (op.op !== "add" || op.element.type !== "arrow") continue;
    const { start, end } = op.element;
    const otherId =
      start?.id === nodeId
        ? end?.id
        : end?.id === nodeId
          ? start?.id
          : undefined;
    if (!otherId) continue;
    const anchor = solids.find((el) => el.id === otherId);
    if (anchor) return anchor;
  }
  return undefined;
}

/**
 * Posição pra um nó de patch sem x/y: perto do nó ancorado por seta
 * (baixo > direita > cima, deslocando até achar espaço livre) ou, sem âncora,
 * abaixo do bounding box existente, empilhando adds do mesmo patch lado a lado.
 * Com layout "auto" é só a posição provisória: o ELK reposiciona em seguida.
 */
function placeAddedNode(
  skel: DiagramSkeletonElement,
  size: { width: number; height: number },
  result: ExElement[],
  ops: DiagramPatchOp[],
  stack: { x: number | null; y: number },
): { x: number; y: number } {
  const solids = result.filter(isSolid);
  const anchor = findLinkAnchor(skel.id, ops, solids);
  if (anchor) {
    const directions: Array<[number, number]> = [
      [0, 1],
      [1, 0],
      [0, -1],
    ];
    for (const [dx, dy] of directions) {
      for (let k = 1; k <= 3; k++) {
        const off = PATCH_ADD_GAP * k;
        const box: Box = {
          x: dx === 0 ? anchor.x : anchor.x + anchor.width + off,
          y:
            dy === 0
              ? anchor.y
              : dy > 0
                ? anchor.y + anchor.height + off
                : anchor.y - off - size.height,
          width: size.width,
          height: size.height,
        };
        if (!collides(box, solids)) return { x: box.x, y: box.y };
      }
    }
  }
  // Sem âncora (ou sem espaço perto dela): linha nova abaixo de tudo.
  if (stack.x === null) {
    const alive = result.filter((el) => !el.isDeleted);
    if (alive.length === 0) {
      stack.x = 0;
      stack.y = 0;
    } else {
      stack.x = Math.min(...alive.map((el) => el.x));
      stack.y =
        Math.max(...alive.map((el) => el.y + el.height)) + PATCH_ADD_GAP;
    }
  }
  const pos = { x: stack.x, y: stack.y };
  stack.x += size.width + GRID_GAP;
  return pos;
}

const plainBinding = (elementId: string) => ({
  elementId,
  focus: 0,
  gap: BINDING_GAP,
});

/** Label centralizado, ou alinhado como o Excalidraw faz (label de grupo). */
function labelPosition(
  container: Box,
  label: Pick<ExText, "width" | "height" | "textAlign" | "verticalAlign">,
): { x: number; y: number } {
  return label.textAlign === "center" && label.verticalAlign === "middle"
    ? centeredIn(container, label)
    : boundTextPosition(container, label);
}

/** O elemento pertence ao nó `id` (o nó, label, partes ou membros dele)? */
function belongsTo(el: ExElement, id: string): boolean {
  return (
    el.id === id ||
    partOwner(el) === id ||
    (el.type === "text" && (el as ExText).containerId === id) ||
    (el.groupIds ?? []).includes(id) ||
    el.frameId === id
  );
}

/** Patch que cria grupo/frame: os filhos existentes entram nele. */
function adoptChildren(
  result: ExElement[],
  compoundId: string,
  kind: "group" | "frame",
  children: readonly string[] = [],
): ExElement[] {
  if (children.length === 0) return result;
  return result.map((el) => {
    if (el.isDeleted || !children.some((c) => belongsTo(el, c))) return el;
    if (kind === "group") {
      if (el.groupIds.includes(compoundId)) return el;
      return bump(el, { groupIds: [...el.groupIds, compoundId] });
    }
    if (el.frameId || el.type === "frame") return el;
    return bump(el, { frameId: compoundId });
  });
}

/** Grupo/frame apagado: os filhos ficam, sem o groupId/frameId dele. */
function releaseChildren(
  result: ExElement[],
  compoundId: string,
  kind: "group" | "frame",
): ExElement[] {
  return result.map((el) => {
    if (el.isDeleted) return el;
    if (kind === "group" && el.groupIds.includes(compoundId)) {
      return bump(el, {
        groupIds: el.groupIds.filter((g) => g !== compoundId),
      });
    }
    if (kind === "frame" && el.frameId === compoundId) {
      return bump(el, { frameId: null });
    }
    return el;
  });
}

/**
 * Update de entity/class: refaz o bloco inteiro (campos mudam a altura e a
 * largura) no mesmo canto. Mantém pin, setas ligadas e pertença a grupos.
 */
function rebuildBlock(
  result: ExElement[],
  idx: number,
  op: Extract<DiagramPatchOp, { op: "update" }>,
): { elements: ExElement[]; changedBox: boolean } {
  const owner = result[idx];
  const texts = new Map(
    result
      .filter(
        (el) => el.type === "text" && !el.isDeleted && (el as ExText).containerId,
      )
      .map((el) => [
        (el as ExText).containerId!,
        (el as ExText).originalText ?? (el as ExText).text,
      ]),
  );
  const current = blockToSkeleton(owner, (cellId) => texts.get(cellId));
  const header = result.find(
    (el) => el.id === `${owner.id}__header` && !el.isDeleted,
  );
  const skel: DiagramSkeletonElement = {
    ...current,
    ...(op.label?.text !== undefined ? { name: op.label.text } : {}),
    ...(op.name !== undefined ? { name: op.name } : {}),
    ...(op.fields !== undefined ? { fields: op.fields } : {}),
    ...(op.attributes !== undefined ? { attributes: op.attributes } : {}),
    ...(op.methods !== undefined ? { methods: op.methods } : {}),
    strokeColor: op.strokeColor ?? header?.strokeColor,
    backgroundColor: op.backgroundColor ?? header?.backgroundColor,
  };
  const moved = op.x !== undefined || op.y !== undefined;
  const pos = { x: op.x ?? owner.x, y: op.y ?? owner.y };
  const built = buildBlock(skel, pos, {
    auto: isAutoPlaced(owner) && !moved,
    ...(directionOf(owner) ? { direction: directionOf(owner) } : {}),
  });
  const outerGroups = owner.groupIds.filter((g) => g !== owner.id);
  const out = result.slice();
  const keepIds = new Set(built.map((el) => el.id));
  built.forEach((fresh, i) => {
    const prevIdx = i === 0 ? idx : out.findIndex((el) => el.id === fresh.id);
    const prev = prevIdx >= 0 ? out[prevIdx] : undefined;
    const merged: ExElement = {
      ...fresh,
      groupIds: [...fresh.groupIds, ...outerGroups],
      frameId: owner.frameId,
      ...(i === 0 ? { boundElements: owner.boundElements } : {}),
      ...(prev
        ? {
            index: prev.index,
            seed: prev.seed,
            version: prev.version + 1,
            isDeleted: false,
          }
        : { index: fractionalIndexAt(out.length) }),
    };
    if (prev) out[prevIdx] = merged;
    else out.push(merged);
  });
  // Linhas que sobraram (campo removido) saem da cena, e também textos que o
  // editor criou com id próprio nas células: o bloco novo traz os dele.
  const cellIds = new Set(
    out
      .filter((el) => partOwner(el) === owner.id && el.type !== "text")
      .map((el) => el.id),
  );
  out.forEach((el, i) => {
    if (el.isDeleted || keepIds.has(el.id)) return;
    const strayText =
      el.type === "text" && cellIds.has((el as ExText).containerId ?? "");
    if (partOwner(el) === owner.id || strayText) {
      out[i] = bump(el, { isDeleted: true });
    }
  });
  const next = out[idx];
  const changedBox =
    moved ||
    Math.abs(next.width - owner.width) > 0.5 ||
    Math.abs(next.height - owner.height) > 0.5;
  return { elements: out, changedBox };
}

/**
 * Caixas de grupo/frame voltam a envolver os filhos (do mais interno pro mais
 * externo) depois que os nós se moveram ou cresceram.
 */
function refitCompounds(result: ExElement[]): void {
  const parents = sceneParents(result);
  const indexOf = new Map(result.map((el, i) => [el.id, i]));
  const ids = result.filter(isCompoundElement).map((el) => el.id);
  for (const id of deepestFirst(ids, parents)) {
    const idx = indexOf.get(id)!;
    const box = result[idx];
    const members = result.filter(
      (el) =>
        parents.get(el.id) === id &&
        (isLayoutNode(el) || isCompoundElement(el)),
    );
    if (members.length === 0) continue;
    const labelRef = (box.boundElements ?? []).find((b) => b.type === "text");
    const fit = fitBox(
      members,
      compoundPadding(compoundKind(box)!, labelRef !== undefined),
    );
    if (
      Math.abs(fit.x - box.x) < 0.5 &&
      Math.abs(fit.y - box.y) < 0.5 &&
      Math.abs(fit.width - box.width) < 0.5 &&
      Math.abs(fit.height - box.height) < 0.5
    ) {
      continue;
    }
    result[idx] = bump(box, fit);
    const labelIdx = labelRef ? indexOf.get(labelRef.id) : undefined;
    if (labelIdx !== undefined) {
      const label = result[labelIdx] as ExText;
      result[labelIdx] = bump(label, labelPosition(fit, label));
    }
  }
}

export interface PatchOpsResult {
  elements: ExElement[];
  /** Nós movidos/redimensionados e setas novas/religadas: rota a refazer. */
  touched: Set<string>;
}

/**
 * Setas que o editor prendeu a uma célula de bloco passam a apontar pro dono
 * (com boundElements simétrico). Sem isto o patch trata a célula como ponta:
 * a seta some do layout e fica presa a uma linha que o rebuild apaga.
 */
function rebindPartArrows(
  elements: ExElement[],
  touched: Set<string>,
): ExElement[] {
  const targetOf = bindingTargetResolver(elements);
  const moves: { arrow: string; from: string; to: string }[] = [];
  const out = elements.map((el) => {
    if (el.isDeleted || el.type !== "arrow") return el;
    const lin = el as ExLinear;
    const rebind = (b: ExLinear["startBinding"]) => {
      if (!b || targetOf(b.elementId) === b.elementId) return b;
      moves.push({ arrow: el.id, from: b.elementId, to: targetOf(b.elementId) });
      return { ...b, elementId: targetOf(b.elementId) };
    };
    const startBinding = rebind(lin.startBinding);
    const endBinding = rebind(lin.endBinding);
    if (startBinding === lin.startBinding && endBinding === lin.endBinding) {
      return el;
    }
    touched.add(el.id);
    return bump(lin, { startBinding, endBinding });
  });
  if (moves.length === 0) return elements;
  return out.map((el) => {
    const away = moves.filter((m) => m.from === el.id).map((m) => m.arrow);
    const into = moves.filter((m) => m.to === el.id).map((m) => m.arrow);
    if (away.length === 0 && into.length === 0) return el;
    const list = (el.boundElements ?? []).filter((b) => !away.includes(b.id));
    for (const id of into) {
      if (!list.some((b) => b.id === id)) list.push({ id, type: "arrow" });
    }
    return bump(el, { boundElements: list });
  });
}

/**
 * Aplica as ops na cena sem calcular layout. Imutável: o array de entrada e
 * os elementos não tocados saem intactos (mesmas referências).
 */
export function applyPatchOps(
  elements: unknown[],
  ops: DiagramPatchOp[],
): PatchOpsResult {
  const touched = new Set<string>();
  let result = rebindPartArrows(elements as ExElement[], touched).slice();
  // Estado da linha de empilhamento pros adds sem posição deste patch.
  const stack: { x: number | null; y: number } = { x: null, y: 0 };

  const findIndex = (id: string) => result.findIndex((el) => el.id === id);

  const linkBack = (targetId: string, arrowId: string) => {
    const idx = findIndex(targetId);
    if (idx < 0) return;
    const target = result[idx];
    const list = (target.boundElements ?? []).slice();
    if (list.some((b) => b.id === arrowId)) return;
    list.push({ id: arrowId, type: "arrow" });
    result[idx] = bump(target, { boundElements: list });
  };

  for (const op of ops) {
    if (op.op === "add") {
      const skel = textAsLabel({ ...op.element });
      if (isCompoundType(skel.type)) {
        result = adoptChildren(result, skel.id, skel.type, skel.children);
      }
      const isNode = skel.type !== "arrow" && skel.type !== "line";
      const explicit = skel.x !== undefined && skel.y !== undefined;
      if (isNode && !explicit) {
        // Nó novo: nunca em cima de conteúdo existente.
        const pos = placeAddedNode(skel, sizeFor(skel), result, ops, stack);
        skel.x ??= Math.round(pos.x);
        skel.y ??= Math.round(pos.y);
      }
      const baseIndex = result.length;
      const prepared: ExElement[] = (
        buildElements([skel], EMPTY_LAYOUT, { layout: "keep" }) as ExElement[]
      ).map((el, i) => {
        const indexed = { ...el, index: fractionalIndexAt(baseIndex + i) };
        // Coordenada dada pelo agente pina; posição nossa fica livre pro layout.
        return isNode && el.id === skel.id
          ? withPitwallMeta(indexed, { auto: !explicit })
          : indexed;
      });
      const arrowIdx = prepared.findIndex(
        (el) => el.id === skel.id && el.type === "arrow",
      );
      if (arrowIdx >= 0 && (skel.start || skel.end)) {
        const startOk = skel.start && findIndex(skel.start.id) >= 0;
        const endOk = skel.end && findIndex(skel.end.id) >= 0;
        prepared[arrowIdx] = {
          ...(prepared[arrowIdx] as ExLinear),
          startBinding: startOk ? plainBinding(skel.start!.id) : null,
          endBinding: endOk ? plainBinding(skel.end!.id) : null,
        };
        if (startOk) linkBack(skel.start!.id, skel.id);
        if (endOk) linkBack(skel.end!.id, skel.id);
        touched.add(skel.id);
      }
      if (isNode) touched.add(skel.id);
      result = result.concat(prepared);
      continue;
    }

    if (op.op === "update") {
      const idx = findIndex(op.id);
      if (idx < 0) continue;
      const el = result[idx];
      if (blockKind(el)) {
        const rebuilt = rebuildBlock(result, idx, op);
        result = rebuilt.elements;
        if (rebuilt.changedBox) touched.add(el.id);
        continue;
      }
      const changes: Partial<ExElement> = {};
      let dx = 0;
      let dy = 0;
      if (op.x !== undefined) {
        dx = op.x - el.x;
        changes.x = op.x;
      }
      if (op.y !== undefined) {
        dy = op.y - el.y;
        changes.y = op.y;
      }
      if (op.width !== undefined) changes.width = op.width;
      if (op.height !== undefined) changes.height = op.height;
      const isShape =
        el.type === "rectangle" ||
        el.type === "ellipse" ||
        el.type === "diamond";
      // Caixa de grupo não cresce pro label: ela se ajusta aos filhos.
      if (op.label?.text !== undefined && isShape && !compoundKind(el)) {
        // Label novo pode não caber: cresce o shape quando o patch não fixa
        // tamanho (grow-only pra não encolher shape já dimensionado).
        const fitted = sizeFor({
          id: el.id,
          type: el.type as DiagramSkeletonElementType,
          label: { text: op.label.text },
        });
        if (op.width === undefined && fitted.width > el.width) {
          changes.width = fitted.width;
        }
        if (op.height === undefined && fitted.height > el.height) {
          changes.height = fitted.height;
        }
      }
      if (op.strokeColor !== undefined) changes.strokeColor = op.strokeColor;
      if (op.backgroundColor !== undefined) {
        changes.backgroundColor = op.backgroundColor;
      }
      if (op.relation !== undefined && el.type === "arrow") {
        const [startHead, endHead] = RELATION_ARROWHEADS[op.relation];
        Object.assign(changes as Partial<ExLinear>, {
          startArrowhead: startHead,
          endArrowhead: endHead,
          customData: {
            ...el.customData,
            pitwall: {
              ...(el.customData?.pitwall as object),
              relation: op.relation,
            },
          },
        });
      }
      if (op.name !== undefined && el.type === "frame") {
        Object.assign(changes, {
          name: op.name,
          customData: {
            ...el.customData,
            pitwall: {
              ...(el.customData?.pitwall as object),
              name: op.name,
            },
          },
        });
      }
      if (op.text !== undefined && el.type === "text") {
        (changes as Partial<ExText>).text = op.text;
        (changes as Partial<ExText>).originalText = op.text;
      }
      const moved = op.x !== undefined || op.y !== undefined;
      let next = bump(el, changes);
      // x/y explícito no patch = o agente quer o nó ali: pina.
      if (moved && isLayoutNode(next)) {
        next = withPitwallMeta(next, { auto: false });
      }
      result[idx] = next;
      if (
        moved ||
        changes.width !== undefined ||
        changes.height !== undefined
      ) {
        touched.add(el.id);
      }

      // Label bound: reescreve texto e/ou arrasta junto no move.
      const boundText = (el.boundElements ?? []).find((b) => b.type === "text");
      if (boundText) {
        const labelIdx = findIndex(boundText.id);
        if (labelIdx >= 0) {
          const label = result[labelIdx] as ExText;
          const labelChanges: Partial<ExText> = {};
          if (op.label?.text !== undefined) {
            labelChanges.text = op.label.text;
            labelChanges.originalText = op.label.text;
            const metrics = textMetrics(op.label.text);
            labelChanges.width = metrics.width;
            labelChanges.height = metrics.height;
            if (isShape) {
              // Reposiciona no shape já atualizado (move + resize inclusos).
              Object.assign(
                labelChanges,
                labelPosition(result[idx], { ...label, ...metrics }),
              );
            } else if (dx !== 0 || dy !== 0) {
              labelChanges.x = label.x + dx;
              labelChanges.y = label.y + dy;
            }
          } else if (
            isShape &&
            (changes.width !== undefined || changes.height !== undefined)
          ) {
            Object.assign(labelChanges, labelPosition(result[idx], label));
          } else if (dx !== 0 || dy !== 0) {
            labelChanges.x = label.x + dx;
            labelChanges.y = label.y + dy;
          }
          if (Object.keys(labelChanges).length > 0) {
            result[labelIdx] = bump(label, labelChanges);
          }
        }
      } else if (op.label?.text !== undefined && el.type !== "text") {
        // Shape sem label ainda: cria um bound text novo, centrado no shape
        // já atualizado (que pode ter crescido pro label caber).
        const shape = result[idx];
        const metrics = textMetrics(op.label.text);
        const at = centeredIn(shape, metrics);
        const label = makeTextElement(
          labelIdFor(el.id),
          op.label.text,
          at.x,
          at.y,
          el.id,
        );
        label.index = fractionalIndexAt(result.length);
        const list = (result[idx].boundElements ?? []).slice();
        list.push({ id: label.id, type: "text" });
        result[idx] = { ...result[idx], boundElements: list };
        result = result.concat(label);
      }

      // Rewire: start/end no update refazem os bindings da arrow contra o
      // array real; a geometria sai em finalizePatchLayout. Sem isto os campos
      // start/end anunciados no schema do diagram_patch seriam no-op
      // silencioso.
      if (
        el.type === "arrow" &&
        (op.start !== undefined || op.end !== undefined)
      ) {
        const lin = result[idx] as ExLinear;
        const startId = op.start?.id ?? lin.startBinding?.elementId;
        const endId = op.end?.id ?? lin.endBinding?.elementId;
        const startOk = startId !== undefined && findIndex(startId) >= 0;
        const endOk = endId !== undefined && findIndex(endId) >= 0;
        if (startOk && endOk) {
          const prevIds = [
            lin.startBinding?.elementId,
            lin.endBinding?.elementId,
          ];
          result[idx] = {
            ...lin,
            startBinding: plainBinding(startId!),
            endBinding: plainBinding(endId!),
          };
          // Backlink: sai dos shapes desligados, entra nos religados.
          for (const oldId of prevIds) {
            if (!oldId || oldId === startId || oldId === endId) continue;
            const oldIdx = findIndex(oldId);
            if (oldIdx < 0) continue;
            const target = result[oldIdx];
            result[oldIdx] = bump(target, {
              boundElements: (target.boundElements ?? []).filter(
                (b) => b.id !== lin.id,
              ),
            });
          }
          linkBack(startId!, lin.id);
          linkBack(endId!, lin.id);
          touched.add(lin.id);
        }
      }
      continue;
    }

    // delete
    const idx = findIndex(op.id);
    if (idx < 0) continue;
    const el = result[idx];
    const deletedIds = new Set([el.id]);
    result[idx] = bump(el, { isDeleted: true });
    // Bloco: as partes (células e textos) vão junto.
    result = result.map((other) => {
      if (other.isDeleted || partOwner(other) !== el.id) return other;
      deletedIds.add(other.id);
      return bump(other, { isDeleted: true });
    });
    // Compound: os filhos ficam, só saem do grupo/frame.
    const kind = compoundKind(el);
    if (kind) result = releaseChildren(result, el.id, kind);

    const boundText = (el.boundElements ?? []).find((b) => b.type === "text");
    if (boundText) {
      const labelIdx = findIndex(boundText.id);
      if (labelIdx >= 0) {
        deletedIds.add(boundText.id);
        result[labelIdx] = bump(result[labelIdx], { isDeleted: true });
      }
    }

    result = result.map((other) => {
      if (other.isDeleted) return other;
      let changed = false;
      const changes: Partial<ExLinear> = {};

      const bound = other.boundElements ?? [];
      const filtered = bound.filter((b) => !deletedIds.has(b.id));
      if (filtered.length !== bound.length) {
        (changes as Partial<ExBase>).boundElements = filtered;
        changed = true;
      }
      if (other.type === "arrow" || other.type === "line") {
        const lin = other as ExLinear;
        if (lin.startBinding && deletedIds.has(lin.startBinding.elementId)) {
          changes.startBinding = null;
          changed = true;
        }
        if (lin.endBinding && deletedIds.has(lin.endBinding.elementId)) {
          changes.endBinding = null;
          changed = true;
        }
      }
      return changed ? bump(other, changes as Partial<ExElement>) : other;
    });
  }

  return { elements: result, touched };
}

/**
 * O ELK não sabe onde estão os nós pinados: a posição dele vale num frame
 * virtual e pode cair em cima de um nó que o humano arrastou. Desliza o nó
 * pelo eixo transversal (fica na mesma camada) até sair de cima dos
 * obstáculos; sem espaço, devolve null.
 */
const SLIDE_STEP = 20;
const SLIDE_MAX_STEPS = 200;

function slideClear(
  box: Box,
  obstacles: readonly Box[],
  direction: DiagramDirection,
): { x: number; y: number } | null {
  for (let k = 0; k <= SLIDE_MAX_STEPS; k++) {
    const off = k * SLIDE_STEP;
    const candidate =
      direction === "LR"
        ? { ...box, y: box.y + off }
        : { ...box, x: box.x + off };
    if (!collides(candidate, obstacles)) {
      return { x: candidate.x, y: candidate.y };
    }
  }
  return null;
}

/** Destino final de cada nó auto: posição do ELK, salvo colisão com pinados. */
function resolveAutoTargets(
  result: ExElement[],
  layout: LayoutResult,
  direction: DiagramDirection,
): {
  targets: Map<number, { x: number; y: number }>;
  displaced: Set<string>;
} {
  const pinned: Box[] = result.filter(
    (el) => isLayoutNode(el) && !isAutoPlaced(el),
  );
  const targets = new Map<number, { x: number; y: number }>();
  const conflicted: number[] = [];
  result.forEach((el, i) => {
    if (!isLayoutNode(el) || !isAutoPlaced(el)) return;
    const to = layout.positions.get(el.id);
    if (!to) return;
    const box = { x: to.x, y: to.y, width: el.width, height: el.height };
    if (collides(box, pinned)) conflicted.push(i);
    else targets.set(i, to);
  });
  const displaced = new Set<string>();
  for (const i of conflicted) {
    const el = result[i];
    const to = layout.positions.get(el.id)!;
    const obstacles: Box[] = [
      ...pinned,
      ...[...targets].map(([j, p]) => ({
        ...p,
        width: result[j].width,
        height: result[j].height,
      })),
    ];
    const box = { x: to.x, y: to.y, width: el.width, height: el.height };
    // Sem espaço na camada: fica onde estava (posição provisória já livre).
    targets.set(
      i,
      slideClear(box, obstacles, direction) ?? { x: el.x, y: el.y },
    );
    displaced.add(el.id);
  }
  return { targets, displaced };
}

/** Desloca o nó (e o label dele) pro ponto do layout. */
function moveNode(
  result: ExElement[],
  idx: number,
  to: { x: number; y: number },
  direction: DiagramDirection,
): void {
  const el = result[idx];
  const dx = to.x - el.x;
  const dy = to.y - el.y;
  result[idx] = withPitwallMeta(bump(el, { x: to.x, y: to.y }), {
    auto: true,
    direction,
  });
  result.forEach((other, j) => {
    if (partOwner(other) === el.id && !other.isDeleted) {
      result[j] = bump(other, { x: other.x + dx, y: other.y + dy });
    }
  });
  const labelRef = (el.boundElements ?? []).find((b) => b.type === "text");
  if (!labelRef) return;
  const labelIdx = result.findIndex((e) => e.id === labelRef.id);
  if (labelIdx < 0) return;
  const label = result[labelIdx];
  result[labelIdx] = bump(label, { x: label.x + dx, y: label.y + dy });
}

const absoluteRoute = (lin: ExLinear): Point[] =>
  (lin.points ?? []).map(([x, y]) => [lin.x + x, lin.y + y] as Point);

/**
 * O ELK centraliza o pai num frame que não sabe dos nós pinados; quando um
 * filho foi arrastado (ou deslocado), o pai auto fica descentrado em relação
 * aos irmãos que continuam auto. Recentra no eixo transversal pela média dos
 * filhos auto, se o lugar novo não colidir. Devolve os ids movidos.
 */
function recenterParents(
  result: ExElement[],
  indexOf: Map<string, number>,
  displaced: Set<string>,
  direction: DiagramDirection,
): string[] {
  const children = new Map<string, ExElement[]>();
  for (const el of result) {
    if (el.isDeleted || el.type !== "arrow") continue;
    const lin = el as ExLinear;
    const from = result[indexOf.get(lin.startBinding?.elementId ?? "") ?? -1];
    const to = result[indexOf.get(lin.endBinding?.elementId ?? "") ?? -1];
    if (!from || !to || from.isDeleted || to.isDeleted) continue;
    children.set(from.id, [...(children.get(from.id) ?? []), to]);
  }
  const moved: string[] = [];
  for (const [parentId, kids] of children) {
    const idx = indexOf.get(parentId)!;
    const parent = result[idx];
    if (!isLayoutNode(parent) || !isAutoPlaced(parent)) continue;
    if (displaced.has(parentId)) continue;
    const disturbed = kids.some((k) => !isAutoPlaced(k) || displaced.has(k.id));
    const autoKids = kids.filter((k) => isAutoPlaced(k));
    if (!disturbed || autoKids.length < 2) continue;
    const mean =
      direction === "LR"
        ? autoKids.reduce((s, k) => s + k.y + k.height / 2, 0) / autoKids.length
        : autoKids.reduce((s, k) => s + k.x + k.width / 2, 0) / autoKids.length;
    const to =
      direction === "LR"
        ? { x: parent.x, y: mean - parent.height / 2 }
        : { x: mean - parent.width / 2, y: parent.y };
    if (Math.abs(to.x - parent.x) < 0.5 && Math.abs(to.y - parent.y) < 0.5) {
      continue;
    }
    const box = { ...to, width: parent.width, height: parent.height };
    const solids = result.filter(
      (el) => el.id !== parentId && !el.isDeleted && isLayoutNode(el),
    );
    if (collides(box, solids)) continue;
    moveNode(result, idx, to, direction);
    moved.push(parentId);
  }
  return moved;
}

const sameGeometry = (a: Partial<ExLinear>, b: Partial<ExLinear>) =>
  JSON.stringify([a.x, a.y, a.points, a.startBinding, a.endBinding]) ===
  JSON.stringify([b.x, b.y, b.points, b.startBinding, b.endBinding]);

/**
 * Fecha o patch: com layout (modo "auto"), nós com auto=true vão pra posição
 * do ELK e nós pinados ficam onde estão; depois as setas afetadas são
 * reroteadas — rota do ELK quando as duas pontas são auto e ela não cruza
 * nenhum nó, senão rota ortogonal própria que desvia de obstáculos. Afetada =
 * tocada pelo patch, com ponta solta, ou cujo caminho cruza um nó que não é
 * origem nem destino (vale também no modo "keep", layout=null).
 */
export function finalizePatchLayout(
  patched: PatchOpsResult,
  layout: LayoutResult | null,
  direction: DiagramDirection,
): unknown[] {
  const result = patched.elements.slice();
  const touched = new Set(patched.touched);
  const indexOf = new Map(result.map((el, i) => [el.id, i]));

  let displaced = new Set<string>();
  if (layout) {
    const resolved = resolveAutoTargets(result, layout, direction);
    displaced = resolved.displaced;
    for (const [i, to] of resolved.targets) {
      const el = result[i];
      if (Math.abs(to.x - el.x) < 0.5 && Math.abs(to.y - el.y) < 0.5) continue;
      moveNode(result, i, to, direction);
      touched.add(el.id);
    }
  }

  if (layout) {
    for (const id of recenterParents(result, indexOf, displaced, direction)) {
      touched.add(id);
      displaced.add(id);
    }
  }

  refitCompounds(result);

  const nodes = result.filter((el) => !el.isDeleted && isLayoutNode(el));

  result.forEach((el, i) => {
    if (el.isDeleted || el.type !== "arrow") return;
    const lin = el as ExLinear;
    const startIdx = indexOf.get(lin.startBinding?.elementId ?? "");
    const endIdx = indexOf.get(lin.endBinding?.elementId ?? "");
    if (startIdx === undefined || endIdx === undefined) return;
    const startEl = result[startIdx];
    const endEl = result[endIdx];
    if (startEl.isDeleted || endEl.isDeleted) return;
    // Nós que não são as pontas: a seta não pode atravessar nenhum deles.
    const others = nodes.filter(
      (n) => n.id !== startEl.id && n.id !== endEl.id,
    );
    const crosses = (route: Point[]) => routeCrossings(route, others) > 0;
    const elkRoute =
      layout &&
      isAutoPlaced(startEl) &&
      isAutoPlaced(endEl) &&
      !displaced.has(startEl.id) &&
      !displaced.has(endEl.id)
        ? layout.routes.get(lin.id)
        : undefined;
    const current = absoluteRoute(lin);
    // Ponta solta: o nó mudou de lugar sem a seta acompanhar.
    const detached =
      current.length < 2 ||
      !pointOnBorder(current[0], startEl) ||
      !pointOnBorder(current[current.length - 1], endEl);
    const affected =
      touched.has(lin.id) ||
      touched.has(startEl.id) ||
      touched.has(endEl.id) ||
      detached;
    // O ELK não conhece os nós pinados: a rota dele pode passar por cima deles.
    let route: Point[] | undefined =
      startEl === endEl
        ? selfLoopRoute(startEl)
        : elkRoute && !crosses(elkRoute)
          ? elkRoute
          : undefined;
    if (!route && (elkRoute || affected || crosses(current))) {
      route = avoidingRoute(startEl, endEl, others);
    }
    if (!route) return;
    if (startEl !== endEl) {
      route = withArrowheadStubs(
        route,
        startEl,
        endEl,
        { start: Boolean(lin.startArrowhead), end: Boolean(lin.endArrowhead) },
        others,
      );
    }
    const geometry = elbowGeometry(route, startEl, endEl);
    if (sameGeometry(lin, geometry)) return;
    const next = bump(lin, geometry);
    result[i] = next;

    const labelRef = (lin.boundElements ?? []).find((b) => b.type === "text");
    const labelIdx = labelRef ? indexOf.get(labelRef.id) : undefined;
    if (labelIdx === undefined) return;
    const label = result[labelIdx];
    const mid = polylineMidpoint(next);
    result[labelIdx] = bump(label, {
      x: mid.x - label.width / 2,
      y: mid.y - label.height / 2,
    });
  });

  return result;
}
