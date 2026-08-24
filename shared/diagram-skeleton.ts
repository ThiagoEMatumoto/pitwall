// Conversor skeleton ⇄ elementos Excalidraw.
// TS puro, sem DOM e sem imports de @excalidraw/* — roda no main process.
// Formato dos elementos baseado em
// node_modules/@excalidraw/excalidraw/dist/types/excalidraw/element/types.d.ts.

export type DiagramSkeletonElementType =
  "rectangle" | "ellipse" | "diamond" | "text" | "arrow" | "line";

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
}

export type DiagramPatchOp =
  | { op: "add"; element: DiagramSkeletonElement }
  | ({ op: "update"; id: string } & Partial<
      Omit<DiagramSkeletonElement, "id" | "op">
    >)
  | { op: "delete"; id: string };

// ---------------------------------------------------------------------------
// Formato interno (estrutural, espelha o .d.ts do Excalidraw)
// ---------------------------------------------------------------------------

interface ExBase {
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
}

interface ExText extends ExBase {
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

interface ExLinear extends ExBase {
  type: "arrow" | "line";
  points: Array<[number, number]>;
  lastCommittedPoint: [number, number] | null;
  startBinding: { elementId: string; focus: number; gap: number } | null;
  endBinding: { elementId: string; focus: number; gap: number } | null;
  startArrowhead: string | null;
  endArrowhead: string | null;
  elbowed?: boolean;
}

type ExElement = ExBase | ExText | ExLinear;

const DEFAULT_STROKE = "#1e1e1e";
const DEFAULT_BACKGROUND = "transparent";
const DEFAULT_SHAPE_WIDTH = 180;
const DEFAULT_SHAPE_HEIGHT = 70;
const FONT_SIZE = 16;
// FONT_FAMILY.Excalifont === 5 é o DEFAULT_FONT_FAMILY na versão instalada.
const FONT_FAMILY_CODE = 5;
const LINE_HEIGHT = 1.25;
const COL_GAP = 260;
const ROW_GAP = 130;

const randInt = () => Math.floor(Math.random() * 2 ** 31);

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Índice fracional válido e monotônico: a0..az, depois b00..bzz. */
function fractionalIndexAt(position: number): string {
  if (position < B62.length) return `a${B62[position]}`;
  const rest = position - B62.length;
  const hi = Math.floor(rest / B62.length) % B62.length;
  const lo = rest % B62.length;
  return `b${B62[hi]}${B62[lo]}`;
}

function textMetrics(text: string): { width: number; height: number } {
  const lines = text.split("\n");
  const longest = lines.reduce((max, l) => Math.max(max, l.length), 0);
  return {
    width: Math.max(1, Math.round(0.6 * FONT_SIZE * longest)),
    height: Math.round(LINE_HEIGHT * FONT_SIZE * lines.length),
  };
}

function baseElement(
  skel: DiagramSkeletonElement,
  x: number,
  y: number,
  width: number,
  height: number,
): ExBase {
  const roundness =
    skel.type === "rectangle"
      ? { type: 3 }
      : skel.type === "arrow" || skel.type === "line"
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

function makeTextElement(
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

const labelIdFor = (ownerId: string) => `${ownerId}__label`;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const centerOf = (b: Box) => ({
  cx: b.x + b.width / 2,
  cy: b.y + b.height / 2,
});

/** Interseção aproximada centro→alvo com a borda do retângulo do shape. */
function borderPoint(
  box: Box,
  towardX: number,
  towardY: number,
): [number, number] {
  const { cx, cy } = centerOf(box);
  const dx = towardX - cx;
  const dy = towardY - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const halfW = box.width / 2;
  const halfH = box.height / 2;
  const tx = dx !== 0 ? halfW / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? halfH / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty, 1);
  return [cx + dx * t, cy + dy * t];
}

// ---------------------------------------------------------------------------
// Auto-layout topológico determinístico
// ---------------------------------------------------------------------------

function autoLayout(
  skeleton: DiagramSkeletonElement[],
): Map<string, { x: number; y: number }> {
  const nodes = skeleton.filter((s) => s.type !== "arrow" && s.type !== "line");
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges: Array<[string, string]> = [];
  for (const s of skeleton) {
    if (s.type === "arrow" && s.start && s.end) {
      if (nodeIds.has(s.start.id) && nodeIds.has(s.end.id)) {
        edges.push([s.start.id, s.end.id]);
      }
    }
  }

  const connected = new Set<string>();
  for (const [a, b] of edges) {
    connected.add(a);
    connected.add(b);
  }

  // Profundidade = caminho mais longo a partir das fontes; relaxação limitada
  // a N passes torna o cálculo determinístico mesmo com ciclos.
  const depth = new Map<string, number>();
  for (const id of connected) depth.set(id, 0);
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const [from, to] of edges) {
      const next = (depth.get(from) ?? 0) + 1;
      if (next > (depth.get(to) ?? 0) && next <= nodes.length) {
        depth.set(to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const positions = new Map<string, { x: number; y: number }>();
  const rowsPerColumn = new Map<number, number>();
  let maxLayeredY = -ROW_GAP;
  for (const node of nodes) {
    if (!connected.has(node.id)) continue;
    const col = depth.get(node.id) ?? 0;
    const row = rowsPerColumn.get(col) ?? 0;
    rowsPerColumn.set(col, row + 1);
    const y = row * ROW_GAP;
    positions.set(node.id, { x: col * COL_GAP, y });
    if (y > maxLayeredY) maxLayeredY = y;
  }

  // Nós sem arestas: grade abaixo das camadas, 4 por linha.
  const isolated = nodes.filter((n) => !connected.has(n.id));
  const baseY = maxLayeredY + ROW_GAP;
  isolated.forEach((node, i) => {
    positions.set(node.id, {
      x: (i % 4) * COL_GAP,
      y: baseY + Math.floor(i / 4) * ROW_GAP,
    });
  });
  return positions;
}

// ---------------------------------------------------------------------------
// skeletonToElements
// ---------------------------------------------------------------------------

export function skeletonToElements(
  skeleton: DiagramSkeletonElement[],
): unknown[] {
  const layout = autoLayout(skeleton);
  const elements: ExElement[] = [];
  const byId = new Map<string, ExElement>();

  const push = (el: ExElement) => {
    elements.push(el);
    byId.set(el.id, el);
  };

  // 1) Shapes e textos soltos primeiro (arrows precisam das caixas prontas).
  for (const skel of skeleton) {
    if (skel.type === "arrow" || skel.type === "line") continue;
    const auto = layout.get(skel.id);
    const x = skel.x ?? auto?.x ?? 0;
    const y = skel.y ?? auto?.y ?? 0;

    if (skel.type === "text") {
      const content = skel.text ?? skel.label?.text ?? "";
      const el = makeTextElement(skel.id, content, x, y, null);
      if (skel.strokeColor) el.strokeColor = skel.strokeColor;
      push(el);
      continue;
    }

    const width = skel.width ?? DEFAULT_SHAPE_WIDTH;
    const height = skel.height ?? DEFAULT_SHAPE_HEIGHT;
    const el = baseElement(skel, x, y, width, height);
    push(el);

    if (skel.label) {
      const metrics = textMetrics(skel.label.text);
      const label = makeTextElement(
        labelIdFor(skel.id),
        skel.label.text,
        x + (width - metrics.width) / 2,
        y + (height - metrics.height) / 2,
        skel.id,
      );
      el.boundElements!.push({ id: label.id, type: "text" });
      push(label);
    }
  }

  // 2) Arrows e lines.
  for (const skel of skeleton) {
    if (skel.type !== "arrow" && skel.type !== "line") continue;

    let x = skel.x ?? 0;
    let y = skel.y ?? 0;
    let points: Array<[number, number]> = [
      [0, 0],
      [skel.width ?? 100, skel.height ?? 0],
    ];
    let startBinding: ExLinear["startBinding"] = null;
    let endBinding: ExLinear["endBinding"] = null;

    const startEl = skel.start ? byId.get(skel.start.id) : undefined;
    const endEl = skel.end ? byId.get(skel.end.id) : undefined;
    if (skel.type === "arrow" && startEl && endEl) {
      const startCenter = centerOf(startEl);
      const endCenter = centerOf(endEl);
      const p1 = borderPoint(startEl, endCenter.cx, endCenter.cy);
      const p2 = borderPoint(endEl, startCenter.cx, startCenter.cy);
      x = p1[0];
      y = p1[1];
      points = [
        [0, 0],
        [p2[0] - p1[0], p2[1] - p1[1]],
      ];
      startBinding = { elementId: startEl.id, focus: 0, gap: 4 };
      endBinding = { elementId: endEl.id, focus: 0, gap: 4 };
    }

    const width = Math.abs(points[1][0]);
    const height = Math.abs(points[1][1]);
    const base = baseElement(skel, x, y, width, height);
    const el: ExLinear = {
      ...base,
      type: skel.type,
      points,
      lastCommittedPoint: null,
      startBinding,
      endBinding,
      startArrowhead: null,
      endArrowhead: skel.type === "arrow" ? "arrow" : null,
    };
    if (skel.type === "arrow") el.elbowed = false;
    push(el);

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
      const midX = x + points[1][0] / 2;
      const midY = y + points[1][1] / 2;
      const label = makeTextElement(
        labelIdFor(skel.id),
        skel.label.text,
        midX - metrics.width / 2,
        midY - metrics.height / 2,
        skel.id,
      );
      el.boundElements!.push({ id: label.id, type: "text" });
      push(label);
    }
  }

  elements.forEach((el, i) => {
    el.index = fractionalIndexAt(i);
  });
  return elements;
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
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function elementsToSkeleton(
  elements: unknown[],
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

  const out: DiagramSkeletonElement[] = [];
  for (const el of live) {
    if (el.type === "text" && (el as ExText).containerId) continue;

    const skel: DiagramSkeletonElement = {
      id: el.id,
      type: el.type as DiagramSkeletonElementType,
      x: Math.round(el.x),
      y: Math.round(el.y),
      width: Math.round(el.width),
      height: Math.round(el.height),
    };

    if (el.type === "text") {
      skel.text = (el as ExText).text;
    } else {
      const label = labelByContainer.get(el.id);
      if (label) skel.label = { text: label.text };
    }

    if (el.type === "arrow" || el.type === "line") {
      const lin = el as ExLinear;
      if (lin.startBinding) skel.start = { id: lin.startBinding.elementId };
      if (lin.endBinding) skel.end = { id: lin.endBinding.elementId };
    }

    if (el.strokeColor && el.strokeColor !== DEFAULT_STROKE) {
      skel.strokeColor = el.strokeColor;
    }
    if (el.backgroundColor && el.backgroundColor !== DEFAULT_BACKGROUND) {
      skel.backgroundColor = el.backgroundColor;
    }
    out.push(skel);
  }

  out.sort((a, b) => a.y! - b.y! || a.x! - b.x! || a.id.localeCompare(b.id));
  return out;
}

// ---------------------------------------------------------------------------
// applyPatch
// ---------------------------------------------------------------------------

function bump<T extends ExElement>(el: T, changes: Partial<T>): T {
  return {
    ...el,
    ...changes,
    version: el.version + 1,
    versionNonce: randInt(),
    updated: Date.now(),
  };
}

export function applyPatch(
  elements: unknown[],
  ops: DiagramPatchOp[],
): unknown[] {
  let result = (elements as ExElement[]).slice();

  const findIndex = (id: string) => result.findIndex((el) => el.id === id);

  for (const op of ops) {
    if (op.op === "add") {
      const skel = { ...op.element };
      if (skel.x === undefined || skel.y === undefined) {
        // Perto do centro de massa dos elementos existentes não-deletados.
        const alive = result.filter((el) => !el.isDeleted);
        let cx = 0;
        let cy = 0;
        if (alive.length > 0) {
          for (const el of alive) {
            cx += el.x + el.width / 2;
            cy += el.y + el.height / 2;
          }
          cx /= alive.length;
          cy /= alive.length;
        }
        skel.x ??= Math.round(cx + 40);
        skel.y ??= Math.round(cy + 40);
      }
      // Reusa o conversor completo passando os shapes existentes como contexto
      // de binding: monta um mini-cenário só com o novo elemento.
      const created = skeletonToElements([skel]) as ExElement[];
      // skeletonToElements não conhece os shapes existentes; refaz bindings de
      // arrow contra o array real.
      const baseIndex = result.length;
      const prepared = created.map((el, i) => ({
        ...el,
        index: fractionalIndexAt(baseIndex + i),
      }));
      const arrow = prepared.find(
        (el) => el.id === skel.id && el.type === "arrow",
      ) as ExLinear | undefined;
      if (arrow && (skel.start || skel.end)) {
        const startIdx = skel.start ? findIndex(skel.start.id) : -1;
        const endIdx = skel.end ? findIndex(skel.end.id) : -1;
        const startEl = startIdx >= 0 ? result[startIdx] : undefined;
        const endEl = endIdx >= 0 ? result[endIdx] : undefined;
        if (startEl && endEl) {
          const sc = centerOf(startEl);
          const ec = centerOf(endEl);
          const p1 = borderPoint(startEl, ec.cx, ec.cy);
          const p2 = borderPoint(endEl, sc.cx, sc.cy);
          arrow.x = p1[0];
          arrow.y = p1[1];
          arrow.points = [
            [0, 0],
            [p2[0] - p1[0], p2[1] - p1[1]],
          ];
          arrow.width = Math.abs(arrow.points[1][0]);
          arrow.height = Math.abs(arrow.points[1][1]);
          arrow.startBinding = { elementId: startEl.id, focus: 0, gap: 4 };
          arrow.endBinding = { elementId: endEl.id, focus: 0, gap: 4 };
        }
        for (const idx of [startIdx, endIdx]) {
          if (idx < 0) continue;
          const target = result[idx];
          const list = (target.boundElements ?? []).slice();
          if (!list.some((b) => b.id === arrow.id)) {
            list.push({ id: arrow.id, type: "arrow" });
          }
          result[idx] = bump(target, { boundElements: list });
        }
      }
      result = result.concat(prepared);
      continue;
    }

    if (op.op === "update") {
      const idx = findIndex(op.id);
      if (idx < 0) continue;
      const el = result[idx];
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
      if (op.strokeColor !== undefined) changes.strokeColor = op.strokeColor;
      if (op.backgroundColor !== undefined) {
        changes.backgroundColor = op.backgroundColor;
      }
      if (op.text !== undefined && el.type === "text") {
        (changes as Partial<ExText>).text = op.text;
        (changes as Partial<ExText>).originalText = op.text;
      }
      result[idx] = bump(el, changes);

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
          }
          if (dx !== 0 || dy !== 0) {
            labelChanges.x = label.x + dx;
            labelChanges.y = label.y + dy;
          }
          if (Object.keys(labelChanges).length > 0) {
            result[labelIdx] = bump(label, labelChanges);
          }
        }
      } else if (op.label?.text !== undefined && el.type !== "text") {
        // Shape sem label ainda: cria um bound text novo.
        const metrics = textMetrics(op.label.text);
        const label = makeTextElement(
          labelIdFor(el.id),
          op.label.text,
          el.x + (el.width - metrics.width) / 2,
          el.y + (el.height - metrics.height) / 2,
          el.id,
        );
        label.index = fractionalIndexAt(result.length);
        const list = (result[idx].boundElements ?? []).slice();
        list.push({ id: label.id, type: "text" });
        result[idx] = { ...result[idx], boundElements: list };
        result = result.concat(label);
      }
      continue;
    }

    // delete
    const idx = findIndex(op.id);
    if (idx < 0) continue;
    const el = result[idx];
    const deletedIds = new Set([el.id]);
    result[idx] = bump(el, { isDeleted: true });

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
      let next = other;
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
      if (changed) next = bump(other, changes as Partial<ExElement>);
      return next;
    });
  }

  return result;
}
