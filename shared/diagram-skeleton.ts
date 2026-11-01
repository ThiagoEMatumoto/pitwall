// Conversor skeleton ⇄ elementos Excalidraw.
// TS puro, síncrono, sem DOM e sem imports de @excalidraw/* — roda no main e
// no renderer. O layout (ELK, async) mora em
// electron/main/services/diagram-layout.ts e entra aqui como LayoutResult.
// Formato dos elementos baseado em
// node_modules/@excalidraw/excalidraw/dist/types/excalidraw/element/types.d.ts.
import { measureText } from "./text-measure";
import {
  blockSize,
  blockToSkeleton,
  boundTextPosition,
  buildBlock,
  isBlockType,
  partOwner,
  relationFromArrowheads,
  RELATION_ARROWHEADS,
  type DiagramRelation,
  type EntityField,
} from "./diagram-shapes";
import {
  compoundKind,
  compoundPadding,
  deepestFirst,
  EMPTY_COMPOUND_SIZE,
  fitBox,
  isCompoundElement,
  isCompoundType,
  membershipFor,
  sceneParents,
  skeletonParents,
  type CompoundKind,
} from "./diagram-compound";

export type { DiagramRelation, EntityField } from "./diagram-shapes";

export type DiagramSkeletonElementType =
  | "rectangle"
  | "ellipse"
  | "diamond"
  | "text"
  | "arrow"
  | "line"
  | "entity"
  | "class"
  | "group"
  | "frame";

export interface DiagramSkeletonElement {
  id: string;
  type: DiagramSkeletonElementType;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Label bound ao shape/arrow (vira elemento text com containerId). */
  label?: { text: string };
  /** Conteúdo para type 'text' solto. */
  text?: string;
  /** Arrows: shape de origem. */
  start?: { id: string };
  /** Arrows: shape de destino. */
  end?: { id: string };
  strokeColor?: string;
  backgroundColor?: string;
  /** entity/class: título do bloco; frame: nome do frame. */
  name?: string;
  /** entity: uma linha por campo. */
  fields?: EntityField[];
  /** class: compartimentos de atributos e métodos (uma string por linha). */
  attributes?: string[];
  methods?: string[];
  /** group/frame: ids dos nós contidos. */
  children?: string[];
  /** Arrows: semântica ER/UML, mapeada pras pontas da seta. */
  relation?: DiagramRelation;
}

export type DiagramPatchOp =
  | { op: "add"; element: DiagramSkeletonElement }
  | ({ op: "update"; id: string } & Partial<
      Omit<DiagramSkeletonElement, "id" | "op">
    >)
  | { op: "delete"; id: string };

/** LR = camadas da esquerda pra direita; TB = de cima pra baixo. */
export type DiagramDirection = "LR" | "TB";
/** auto = o layout posiciona os nós não pinados; keep = nada se move. */
export type DiagramLayoutMode = "auto" | "keep";

export interface DiagramLayoutOptions {
  direction?: DiagramDirection;
  layout?: DiagramLayoutMode;
}

// ---------------------------------------------------------------------------
// Contrato com o motor de layout
// ---------------------------------------------------------------------------

export type Point = [number, number];

export interface LayoutCompound {
  id: string;
  parent?: string;
  padding: { top: number; left: number; bottom: number; right: number };
}

export interface LayoutGraph {
  direction: DiagramDirection;
  nodes: Array<{ id: string; width: number; height: number; parent?: string }>;
  /** group/frame com filhos: compound nodes do ELK (filhos via parent). */
  compounds?: LayoutCompound[];
  edges: Array<{
    id: string;
    source: string;
    target: string;
    label?: { width: number; height: number };
  }>;
}

export interface LayoutResult {
  /** Canto superior esquerdo de cada nó. */
  positions: Map<string, { x: number; y: number }>;
  /** Rota ortogonal absoluta de cada aresta: início, dobras, fim. */
  routes: Map<string, Point[]>;
}

// ---------------------------------------------------------------------------
// Formato interno (estrutural, espelha o .d.ts do Excalidraw)
// ---------------------------------------------------------------------------

export interface ExBase {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: string;
  strokeWidth: number;
  strokeStyle: string;
  roughness: number;
  opacity: number;
  groupIds: string[];
  frameId: string | null;
  roundness: { type: number } | null;
  seed: number;
  version: number;
  versionNonce: number;
  index: string | null;
  isDeleted: boolean;
  boundElements: Array<{ id: string; type: "arrow" | "text" }> | null;
  updated: number;
  link: string | null;
  locked: boolean;
  customData?: Record<string, unknown>;
}

export interface ExText extends ExBase {
  type: "text";
  fontSize: number;
  fontFamily: number;
  text: string;
  textAlign: string;
  verticalAlign: string;
  containerId: string | null;
  originalText: string;
  autoResize: boolean;
  lineHeight: number;
}

export interface ExBinding {
  elementId: string;
  focus: number;
  gap: number;
  /** FixedPointBinding das setas elbow: ponto relativo à caixa, em [0,1]. */
  fixedPoint?: Point;
}

export interface ExLinear extends ExBase {
  type: "arrow" | "line";
  points: Point[];
  lastCommittedPoint: Point | null;
  startBinding: ExBinding | null;
  endBinding: ExBinding | null;
  startArrowhead: string | null;
  endArrowhead: string | null;
  elbowed?: boolean;
  fixedSegments?: null;
  startIsSpecial?: boolean | null;
  endIsSpecial?: boolean | null;
}

export interface ExFrame extends ExBase {
  type: "frame";
  name: string | null;
}

export type ExElement = ExBase | ExText | ExLinear | ExFrame;

export const DEFAULT_STROKE = "#1e1e1e";
export const DEFAULT_BACKGROUND = "transparent";
const DEFAULT_SHAPE_WIDTH = 180;
const DEFAULT_SHAPE_HEIGHT = 70;
const FONT_SIZE = 16;
// FONT_FAMILY.Excalifont === 5 é o DEFAULT_FONT_FAMILY na versão instalada.
const FONT_FAMILY_CODE = 5;
const LINE_HEIGHT = 1.25;
// Folga do shape em volta do label auto-dimensionado.
const LABEL_H_PADDING = 48;
const LABEL_V_PADDING = 32;
// Texto inscrito em diamond/ellipse precisa de folga geométrica extra.
const INSCRIBED_TEXT_FACTOR = 1.45;
const BINDING_GAP = 4;

export const randInt = () => Math.floor(Math.random() * 2 ** 31);

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Índice fracional válido e monotônico: a0..az, depois b00..bzz. */
export function fractionalIndexAt(position: number): string {
  if (position < B62.length) return `a${B62[position]}`;
  const rest = position - B62.length;
  const hi = Math.floor(rest / B62.length) % B62.length;
  const lo = rest % B62.length;
  return `b${B62[hi]}${B62[lo]}`;
}

export function textMetrics(text: string): { width: number; height: number } {
  const m = measureText(text, FONT_SIZE, LINE_HEIGHT);
  return { width: Math.max(1, m.width), height: m.height };
}

export const isLinearType = (type: string) =>
  type === "arrow" || type === "line";

/**
 * Tamanho efetivo de um elemento do skeleton. Shapes sem width/height
 * explícitos crescem pra caber o label (diamond/ellipse com folga geométrica,
 * já que o texto fica inscrito).
 */
export function sizeFor(skel: DiagramSkeletonElement): {
  width: number;
  height: number;
} {
  if (skel.type === "text") {
    return textMetrics(skel.text ?? skel.label?.text ?? "");
  }
  if (isLinearType(skel.type)) {
    return { width: skel.width ?? 100, height: skel.height ?? 0 };
  }
  if (isBlockType(skel.type)) return blockSize(skel);
  if (isCompoundType(skel.type)) {
    return {
      width: skel.width ?? EMPTY_COMPOUND_SIZE.width,
      height: skel.height ?? EMPTY_COMPOUND_SIZE.height,
    };
  }
  let width = skel.width;
  let height = skel.height;
  const labelText = skel.label?.text;
  if (
    labelText !== undefined &&
    (width === undefined || height === undefined)
  ) {
    const m = textMetrics(labelText);
    const factor =
      skel.type === "diamond" || skel.type === "ellipse"
        ? INSCRIBED_TEXT_FACTOR
        : 1;
    width ??= Math.max(
      DEFAULT_SHAPE_WIDTH,
      Math.ceil(m.width * factor) + LABEL_H_PADDING,
    );
    height ??= Math.max(
      DEFAULT_SHAPE_HEIGHT,
      Math.ceil(m.height * factor) + LABEL_V_PADDING,
    );
  }
  return {
    width: width ?? DEFAULT_SHAPE_WIDTH,
    height: height ?? DEFAULT_SHAPE_HEIGHT,
  };
}

// ---------------------------------------------------------------------------
// Pin: customData.pitwall.auto
// ---------------------------------------------------------------------------

/**
 * true = posição veio do layout e pode ser recalculada; false = o humano (ou
 * um patch com x/y) fixou o nó. Ausente (cena antiga) conta como pinado: não
 * mexemos em layout que não sabemos de onde veio.
 */
export function isAutoPlaced(el: ExBase): boolean {
  const meta = el.customData?.pitwall as { auto?: unknown } | undefined;
  return meta?.auto === true;
}

export function directionOf(el: ExBase): DiagramDirection | undefined {
  const meta = el.customData?.pitwall as { direction?: unknown } | undefined;
  return meta?.direction === "LR" || meta?.direction === "TB"
    ? meta.direction
    : undefined;
}

export function withPitwallMeta<T extends ExBase>(
  el: T,
  meta: { auto: boolean; direction?: DiagramDirection },
): T {
  const prev = (el.customData?.pitwall as Record<string, unknown>) ?? {};
  return {
    ...el,
    customData: { ...el.customData, pitwall: { ...prev, ...meta } },
  };
}

/**
 * Nó folha do layout. Partes de bloco (header/linhas) andam com o dono e
 * compounds (grupo/frame) envolvem os filhos — nenhum dos dois é nó solto.
 */
export const isLayoutNode = (el: ExElement) =>
  !el.isDeleted &&
  !isLinearType(el.type) &&
  !(el.type === "text" && (el as ExText).containerId) &&
  partOwner(el) === undefined &&
  compoundKind(el) === undefined;

/**
 * Marca como pinado (auto=false) todo nó auto cuja posição divergiu da
 * baseline persistida — é como o editor registra "o usuário arrastou isto".
 * Devolve o MESMO array quando nada mudou.
 */
export function pinMovedNodes(
  elements: readonly unknown[],
  baseline: ReadonlyMap<string, { x: number; y: number }>,
): readonly unknown[] {
  let changed = false;
  const out = (elements as ExElement[]).map((el) => {
    if (!isLayoutNode(el) || !isAutoPlaced(el)) return el;
    const before = baseline.get(el.id);
    if (!before) return el;
    if (Math.abs(before.x - el.x) < 0.5 && Math.abs(before.y - el.y) < 0.5) {
      return el;
    }
    changed = true;
    return {
      ...withPitwallMeta(el, { auto: false }),
      version: el.version + 1,
      versionNonce: randInt(),
    };
  });
  return changed ? out : elements;
}

export function positionsOf(
  elements: readonly unknown[],
): Map<string, { x: number; y: number }> {
  const map = new Map<string, { x: number; y: number }>();
  for (const el of elements as ExElement[]) {
    if (el && typeof el === "object" && typeof el.id === "string") {
      map.set(el.id, { x: el.x, y: el.y });
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Construtores de elemento
// ---------------------------------------------------------------------------

export function baseElement(
  skel: Pick<
    DiagramSkeletonElement,
    "id" | "type" | "strokeColor" | "backgroundColor"
  >,
  x: number,
  y: number,
  width: number,
  height: number,
): ExBase {
  const roundness =
    skel.type === "rectangle"
      ? { type: 3 }
      : isLinearType(skel.type)
        ? { type: 2 }
        : null;
  return {
    id: skel.id,
    type: skel.type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: skel.strokeColor ?? DEFAULT_STROKE,
    backgroundColor: skel.backgroundColor ?? DEFAULT_BACKGROUND,
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness,
    seed: randInt(),
    version: 1,
    versionNonce: randInt(),
    index: null,
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

export function makeTextElement(
  id: string,
  text: string,
  x: number,
  y: number,
  containerId: string | null,
): ExText {
  const { width, height } = textMetrics(text);
  const base = baseElement({ id, type: "text" }, x, y, width, height);
  return {
    ...base,
    type: "text",
    fontSize: FONT_SIZE,
    fontFamily: FONT_FAMILY_CODE,
    text,
    textAlign: containerId ? "center" : "left",
    verticalAlign: containerId ? "middle" : "top",
    containerId,
    originalText: text,
    autoResize: true,
    lineHeight: LINE_HEIGHT,
  };
}

export const labelIdFor = (ownerId: string) => `${ownerId}__label`;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const centerOf = (b: Box) => ({
  cx: b.x + b.width / 2,
  cy: b.y + b.height / 2,
});

/** Posição do label centralizado na caixa. */
export function centeredIn(
  box: Box,
  size: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: box.x + (box.width - size.width) / 2,
    y: box.y + (box.height - size.height) / 2,
  };
}

// ---------------------------------------------------------------------------
// Rotas ortogonais e setas elbow
// ---------------------------------------------------------------------------

/**
 * Rota ortogonal própria entre duas caixas (usada quando um dos lados está
 * pinado e a rota do ELK não vale): sai pelo lado voltado pro alvo, dobra no
 * meio do vão e entra pelo lado oposto.
 */
export function orthogonalRoute(a: Box, b: Box): Point[] {
  const ac = centerOf(a);
  const bc = centerOf(b);
  const gapX = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
  const gapY = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
  if (gapX >= gapY) {
    const right = bc.cx >= ac.cx;
    const sx = right ? a.x + a.width : a.x;
    const ex = right ? b.x : b.x + b.width;
    if (Math.abs(ac.cy - bc.cy) < 0.5) {
      return [
        [sx, ac.cy],
        [ex, ac.cy],
      ];
    }
    const mid = (sx + ex) / 2;
    return [
      [sx, ac.cy],
      [mid, ac.cy],
      [mid, bc.cy],
      [ex, bc.cy],
    ];
  }
  const down = bc.cy >= ac.cy;
  const sy = down ? a.y + a.height : a.y;
  const ey = down ? b.y : b.y + b.height;
  if (Math.abs(ac.cx - bc.cx) < 0.5) {
    return [
      [ac.cx, sy],
      [ac.cx, ey],
    ];
  }
  const mid = (sy + ey) / 2;
  return [
    [ac.cx, sy],
    [ac.cx, mid],
    [bc.cx, mid],
    [bc.cx, ey],
  ];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// O Excalidraw desloca 0.5 exato pra 0.5001 (normalizeFixedPoint) pra não
// ficar ambíguo entre dois lados; fazemos igual pra não reescrever no load.
const normalizeRatio = (v: number) => {
  const r = clamp01(v);
  return Math.abs(r - 0.5) < 1e-4 ? 0.5001 : r;
};

function fixedBinding(el: Box & { id: string }, p: Point): ExBinding {
  return {
    elementId: el.id,
    focus: 0,
    gap: BINDING_GAP,
    fixedPoint: [
      normalizeRatio(el.width > 0 ? (p[0] - el.x) / el.width : 0.5),
      normalizeRatio(el.height > 0 ? (p[1] - el.y) / el.height : 0.5),
    ],
  };
}

/** Campos de geometria/binding de uma seta elbow que segue a rota absoluta. */
export function elbowGeometry(
  route: Point[],
  startEl: Box & { id: string },
  endEl: Box & { id: string },
): Partial<ExLinear> {
  const [x0, y0] = route[0];
  const points = route.map(([x, y]) => [x - x0, y - y0] as Point);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    x: x0,
    y: y0,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    points,
    startBinding: fixedBinding(startEl, route[0]),
    endBinding: fixedBinding(endEl, route[route.length - 1]),
    elbowed: true,
    roundness: null,
    fixedSegments: null,
    startIsSpecial: null,
    endIsSpecial: null,
  };
}

/** Ponto no meio do comprimento da polilinha (onde vai o label da seta). */
export function polylineMidpoint(arrow: Pick<ExLinear, "x" | "y" | "points">): {
  x: number;
  y: number;
} {
  const pts = arrow.points;
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  let walked = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(
      pts[i][0] - pts[i - 1][0],
      pts[i][1] - pts[i - 1][1],
    );
    if (walked + seg >= total / 2 && seg > 0) {
      const t = (total / 2 - walked) / seg;
      return {
        x: arrow.x + pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
        y: arrow.y + pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t,
      };
    }
    walked += seg;
  }
  return { x: arrow.x, y: arrow.y };
}

// ---------------------------------------------------------------------------
// Grafo de layout
// ---------------------------------------------------------------------------

export function skeletonLayoutGraph(
  skeleton: DiagramSkeletonElement[],
  direction: DiagramDirection,
): LayoutGraph {
  const parents = skeletonParents(skeleton);
  const withChildren = new Set(parents.values());
  const compounds: LayoutCompound[] = [];
  const nodes: LayoutGraph["nodes"] = [];
  for (const s of skeleton) {
    if (isLinearType(s.type)) continue;
    const parent = parents.get(s.id);
    if (isCompoundType(s.type) && withChildren.has(s.id)) {
      compounds.push({
        id: s.id,
        ...(parent ? { parent } : {}),
        padding: compoundPadding(s.type, Boolean(s.label?.text)),
      });
      continue;
    }
    nodes.push({ id: s.id, ...sizeFor(s), ...(parent ? { parent } : {}) });
  }
  // Setas só entre folhas: aresta pra compound o ELK não roteia bem.
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges: LayoutGraph["edges"] = [];
  for (const s of skeleton) {
    if (s.type !== "arrow" || !s.start || !s.end) continue;
    if (!nodeIds.has(s.start.id) || !nodeIds.has(s.end.id)) continue;
    edges.push({
      id: s.id,
      source: s.start.id,
      target: s.end.id,
      ...(s.label?.text ? { label: textMetrics(s.label.text) } : {}),
    });
  }
  return { direction, nodes, edges, compounds };
}

/** Grafo da cena viva (nós = shapes e textos soltos; arestas = setas ligadas). */
export function elementsLayoutGraph(
  elements: readonly unknown[],
  direction: DiagramDirection,
): LayoutGraph {
  const els = elements as ExElement[];
  const parents = sceneParents(els);
  const withChildren = new Set<string>();
  for (const el of els) {
    if (!isLayoutNode(el) && !isCompoundElement(el)) continue;
    const parent = parents.get(el.id);
    if (parent) withChildren.add(parent);
  }
  const compounds: LayoutCompound[] = els
    .filter((el) => isCompoundElement(el) && withChildren.has(el.id))
    .map((el) => {
      const parent = parents.get(el.id);
      return {
        id: el.id,
        ...(parent ? { parent } : {}),
        padding: compoundPadding(
          compoundKind(el)!,
          (el.boundElements ?? []).some((b) => b.type === "text"),
        ),
      };
    });
  const nodes = els.filter(isLayoutNode).map((el) => {
    const parent = parents.get(el.id);
    return {
      id: el.id,
      width: el.width,
      height: el.height,
      ...(parent ? { parent } : {}),
    };
  });
  const nodeIds = new Set(nodes.map((n) => n.id));
  const byId = new Map(els.map((el) => [el.id, el]));
  const edges: LayoutGraph["edges"] = [];
  for (const el of els) {
    if (el.isDeleted || el.type !== "arrow") continue;
    const lin = el as ExLinear;
    const source = lin.startBinding?.elementId;
    const target = lin.endBinding?.elementId;
    if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) {
      continue;
    }
    const labelRef = (el.boundElements ?? []).find((b) => b.type === "text");
    const label = labelRef ? byId.get(labelRef.id) : undefined;
    edges.push({
      id: el.id,
      source,
      target,
      ...(label && !label.isDeleted
        ? { label: { width: label.width, height: label.height } }
        : {}),
    });
  }
  return { direction, nodes, edges, compounds };
}

// ---------------------------------------------------------------------------
// buildElements (síncrono, isomórfico)
// ---------------------------------------------------------------------------

/**
 * Monta os elementos a partir do skeleton e de um layout já calculado.
 * layout "auto": a posição é SEMPRE a do layout (x/y do skeleton são
 * ignorados — o agente costuma reenviar coordenadas velhas do diagram_get).
 * layout "keep": x/y do skeleton vencem; nó sem coordenada usa o layout.
 */
export function buildElements(
  skeleton: DiagramSkeletonElement[],
  layout: LayoutResult,
  options: DiagramLayoutOptions = {},
): unknown[] {
  const mode = options.layout ?? "auto";
  const direction = options.direction ?? "LR";
  const parents = skeletonParents(skeleton);
  const kindById = new Map<string, CompoundKind>();
  for (const s of skeleton) {
    if (isCompoundType(s.type)) kindById.set(s.id, s.type);
  }
  const membership = (id: string) =>
    membershipFor(id, parents, (a) => kindById.get(a));
  const leaves: ExElement[] = [];
  const linears: ExElement[] = [];
  const byId = new Map<string, ExElement>();
  const positionOf = (skel: DiagramSkeletonElement) => {
    const explicit =
      mode === "keep" && skel.x !== undefined && skel.y !== undefined;
    const pos = explicit
      ? { x: skel.x!, y: skel.y! }
      : (layout.positions.get(skel.id) ?? { x: skel.x ?? 0, y: skel.y ?? 0 });
    return { pos, meta: { auto: !explicit, direction } };
  };

  // 1) Nós folha (shapes, textos soltos, blocos); setas precisam das caixas.
  for (const skel of skeleton) {
    if (isLinearType(skel.type) || isCompoundType(skel.type)) continue;
    const { pos, meta } = positionOf(skel);
    const group = buildNode(skel, pos, meta);
    const { groupIds, frameId } = membership(skel.id);
    for (const el of group) {
      el.groupIds = [...el.groupIds, ...groupIds];
      el.frameId = frameId;
      leaves.push(el);
      byId.set(el.id, el);
    }
  }

  // 2) Compounds, do mais interno pro mais externo: a caixa envolve os filhos
  // já posicionados com o mesmo padding que o ELK reservou.
  const groupBoxes: ExElement[][] = [];
  const frames: ExElement[] = [];
  const compoundSkels = new Map(
    skeleton.filter((s) => isCompoundType(s.type)).map((s) => [s.id, s]),
  );
  for (const id of deepestFirst([...compoundSkels.keys()], parents)) {
    const skel = compoundSkels.get(id)!;
    const kind = skel.type as CompoundKind;
    const labelText = kind === "group" ? skel.label?.text : undefined;
    const members = skeleton
      .filter((c) => parents.get(c.id) === id)
      .map((c) => byId.get(c.id))
      .filter((el): el is ExElement => el !== undefined);
    const { pos, meta } = positionOf(skel);
    const box =
      members.length > 0
        ? fitBox(members, compoundPadding(kind, Boolean(labelText)))
        : { ...pos, ...sizeFor(skel) };
    const { groupIds, frameId } = membership(id);
    const pitwall =
      kind === "group"
        ? { kind, ...(labelText ? { label: labelText } : {}) }
        : { kind, name: skel.name ?? skel.label?.text ?? null };
    const base = withPitwallMeta(
      {
        ...baseElement(
          { ...skel, type: kind === "group" ? "rectangle" : "frame" },
          box.x,
          box.y,
          box.width,
          box.height,
        ),
        customData: { pitwall },
      },
      meta,
    );
    if (kind === "frame") {
      const frame: ExFrame = {
        ...base,
        type: "frame",
        name: (pitwall as { name: string | null }).name,
        roundness: null,
        groupIds,
        frameId: null,
      };
      frames.push(frame);
      byId.set(id, frame);
      continue;
    }
    const groupBox: ExBase = {
      ...base,
      strokeColor: skel.strokeColor ?? GROUP_STROKE,
      strokeStyle: "dashed",
      groupIds: [id, ...groupIds],
      frameId,
    };
    const out: ExElement[] = [groupBox];
    if (labelText) {
      const label: ExText = {
        ...makeTextElement(labelIdFor(id), labelText, 0, 0, id),
        textAlign: "left",
        verticalAlign: "top",
        groupIds: groupBox.groupIds,
        frameId,
      };
      Object.assign(label, boundTextPosition(groupBox, label));
      groupBox.boundElements = [{ id: label.id, type: "text" }];
      out.push(label);
    }
    groupBoxes.push(out);
    byId.set(id, groupBox);
  }

  // 3) Arrows e lines.
  for (const skel of skeleton) {
    if (!isLinearType(skel.type)) continue;
    const startEl = skel.start ? byId.get(skel.start.id) : undefined;
    const endEl = skel.end ? byId.get(skel.end.id) : undefined;
    const base = baseElement(skel, skel.x ?? 0, skel.y ?? 0, 0, 0);
    const heads =
      skel.type === "arrow" && skel.relation
        ? RELATION_ARROWHEADS[skel.relation]
        : null;
    let el: ExLinear = {
      ...base,
      type: skel.type as ExLinear["type"],
      width: skel.width ?? 100,
      height: skel.height ?? 0,
      points: [
        [0, 0],
        [skel.width ?? 100, skel.height ?? 0],
      ],
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: heads ? heads[0] : null,
      endArrowhead: heads ? heads[1] : skel.type === "arrow" ? "arrow" : null,
      ...(heads
        ? { customData: { pitwall: { relation: skel.relation } } }
        : {}),
    };
    if (skel.type === "arrow") el.elbowed = false;

    if (skel.type === "arrow" && startEl && endEl) {
      const bothAuto = isAutoPlaced(startEl) && isAutoPlaced(endEl);
      const route =
        (bothAuto ? layout.routes.get(skel.id) : undefined) ??
        orthogonalRoute(startEl, endEl);
      el = { ...el, ...elbowGeometry(route, startEl, endEl) };
    }
    linears.push(el);

    // Bindings simétricos: shapes referenciados apontam de volta pra arrow.
    for (const bound of [startEl, endEl]) {
      if (!bound) continue;
      const list = (bound.boundElements ??= []);
      if (!list.some((b) => b.id === el.id)) {
        list.push({ id: el.id, type: "arrow" });
      }
    }

    if (skel.label) {
      const metrics = textMetrics(skel.label.text);
      const mid = polylineMidpoint(el);
      const label = makeTextElement(
        labelIdFor(skel.id),
        skel.label.text,
        mid.x - metrics.width / 2,
        mid.y - metrics.height / 2,
        skel.id,
      );
      el.boundElements!.push({ id: label.id, type: "text" });
      linears.push(label);
    }
  }

  // Caixa de grupo por baixo dos filhos (externa primeiro); frames por cima,
  // como o editor ordena ao embrulhar uma seleção num frame.
  const elements = [
    ...groupBoxes.reverse().flat(),
    ...leaves,
    ...linears,
    ...frames,
  ];
  elements.forEach((el, i) => {
    el.index = fractionalIndexAt(i);
  });
  return elements;
}

const GROUP_STROKE = "#868e96";

/** Elementos de um nó folha: o nó primeiro, depois label/partes. */
export function buildNode(
  skel: DiagramSkeletonElement,
  pos: { x: number; y: number },
  meta: { auto: boolean; direction?: DiagramDirection },
): ExElement[] {
  if (skel.type === "text") {
    const content = skel.text ?? skel.label?.text ?? "";
    const el = withPitwallMeta(
      makeTextElement(skel.id, content, pos.x, pos.y, null),
      meta,
    );
    if (skel.strokeColor) el.strokeColor = skel.strokeColor;
    return [el];
  }
  if (isBlockType(skel.type)) return buildBlock(skel, pos, meta);

  const { width, height } = sizeFor(skel);
  const el = withPitwallMeta(
    baseElement(skel, pos.x, pos.y, width, height),
    meta,
  );
  if (!skel.label) return [el];
  const metrics = textMetrics(skel.label.text);
  const at = centeredIn(el, metrics);
  const label = makeTextElement(
    labelIdFor(skel.id),
    skel.label.text,
    at.x,
    at.y,
    skel.id,
  );
  el.boundElements!.push({ id: label.id, type: "text" });
  return [el, label];
}

// ---------------------------------------------------------------------------
// elementsToSkeleton
// ---------------------------------------------------------------------------

const SKELETON_TYPES = new Set([
  "rectangle",
  "ellipse",
  "diamond",
  "text",
  "arrow",
  "line",
  "frame",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Skeleton semântico da cena. Sem geometria por padrão: x/y/width/height que
 * o agente lê tendem a voltar como coordenadas velhas num próximo update.
 * Blocos (entity/class) e compounds (group/frame) voltam como um elemento só;
 * as partes internas não aparecem.
 */
export function elementsToSkeleton(
  elements: unknown[],
  options: { includeGeometry?: boolean } = {},
): DiagramSkeletonElement[] {
  const els = elements.filter(isRecord) as unknown as ExElement[];
  const live = els.filter((el) => !el.isDeleted && SKELETON_TYPES.has(el.type));
  const labelByContainer = new Map<string, ExText>();
  for (const el of live) {
    if (el.type === "text") {
      const t = el as ExText;
      if (t.containerId) labelByContainer.set(t.containerId, t);
    }
  }
  const textOf = (containerId: string) => {
    const label = labelByContainer.get(containerId);
    return label ? (label.originalText ?? label.text) : undefined;
  };
  const parents = sceneParents(live);
  const childrenOf = new Map<string, string[]>();
  for (const el of live) {
    if (!isLayoutNode(el) && !isCompoundElement(el)) continue;
    const parent = parents.get(el.id);
    if (parent)
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), el.id]);
  }

  const ordered = live
    .filter(
      (el) =>
        !(el.type === "text" && (el as ExText).containerId) &&
        partOwner(el) === undefined,
    )
    .sort(
      (a, b) =>
        Math.round(a.y) - Math.round(b.y) ||
        Math.round(a.x) - Math.round(b.x) ||
        a.id.localeCompare(b.id),
    );

  return ordered.map((el) => {
    const kind = compoundKind(el);
    let skel: DiagramSkeletonElement;
    if (blockKindOf(el)) {
      skel = blockToSkeleton(el, textOf);
    } else if (kind) {
      skel = { id: el.id, type: kind, children: childrenOf.get(el.id) ?? [] };
      if (kind === "frame") {
        const name = (el as ExFrame).name;
        if (name) skel.name = name;
      } else {
        const text = textOf(el.id);
        if (text) skel.label = { text };
      }
    } else {
      skel = { id: el.id, type: el.type as DiagramSkeletonElementType };
      if (el.type === "text") {
        skel.text = (el as ExText).text;
      } else {
        const text = textOf(el.id);
        if (text !== undefined) skel.label = { text };
      }
    }
    if (options.includeGeometry) {
      skel.x = Math.round(el.x);
      skel.y = Math.round(el.y);
      skel.width = Math.round(el.width);
      skel.height = Math.round(el.height);
    }

    if (isLinearType(el.type)) {
      const lin = el as ExLinear;
      if (lin.startBinding) skel.start = { id: lin.startBinding.elementId };
      if (lin.endBinding) skel.end = { id: lin.endBinding.elementId };
      const relation = relationFromArrowheads(
        lin.startArrowhead,
        lin.endArrowhead,
        (lin.customData?.pitwall as { relation?: unknown } | undefined)
          ?.relation,
      );
      if (relation) skel.relation = relation;
    }

    if (blockKindOf(el)) {
      // Cor do bloco mora nas partes; o dono tem contorno invisível.
      const header = els.find((p) => p.id === `${el.id}__header`);
      if (header?.strokeColor && header.strokeColor !== DEFAULT_STROKE) {
        skel.strokeColor = header.strokeColor;
      }
      return skel;
    }
    if (
      el.strokeColor &&
      el.strokeColor !== DEFAULT_STROKE &&
      !(kind === "group" && el.strokeColor === GROUP_STROKE)
    ) {
      skel.strokeColor = el.strokeColor;
    }
    if (el.backgroundColor && el.backgroundColor !== DEFAULT_BACKGROUND) {
      skel.backgroundColor = el.backgroundColor;
    }
    return skel;
  });
}

const blockKindOf = (el: ExElement) =>
  isBlockType(String((el.customData?.pitwall as { kind?: unknown })?.kind));
