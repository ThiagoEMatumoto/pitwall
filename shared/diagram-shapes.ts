// Shapes compostos (entidade ER e classe UML) e relações de seta. TS puro,
// isomórfico. Cada bloco vira:
// - um retângulo "dono" (id do skeleton, contorno invisível) que é o nó do
//   ELK e o alvo das setas;
// - partes por cima dele (header + linhas/compartimentos, cada uma um
//   retângulo com bound text), marcadas com customData.pitwall.part = dono.
// Tudo no mesmo groupIds, então o editor arrasta o bloco inteiro junto.
import {
  baseElement,
  makeTextElement,
  textMetrics,
  withPitwallMeta,
  type DiagramDirection,
  type DiagramSkeletonElement,
  type ExBase,
  type ExElement,
  type ExText,
} from "./diagram-skeleton";

export interface EntityField {
  name: string;
  type?: string;
  pk?: boolean;
  fk?: boolean;
}

export type BlockKind = "entity" | "class";

export type DiagramRelation =
  | "1:1"
  | "1:N"
  | "N:M"
  | "association"
  | "inheritance"
  | "composition"
  | "aggregation";

type Arrowhead =
  | "crowfoot_one"
  | "crowfoot_many"
  | "crowfoot_one_or_many"
  | "triangle_outline"
  | "diamond"
  | "diamond_outline"
  | null;

/**
 * [startArrowhead, endArrowhead]. Convenção: em inheritance a seta vai da
 * subclasse (start) pra superclasse (end); em composition/aggregation o
 * losango fica no todo (start).
 */
export const RELATION_ARROWHEADS: Record<
  DiagramRelation,
  [Arrowhead, Arrowhead]
> = {
  "1:1": ["crowfoot_one", "crowfoot_one"],
  "1:N": ["crowfoot_one", "crowfoot_many"],
  "N:M": ["crowfoot_one_or_many", "crowfoot_one_or_many"],
  association: [null, null],
  inheritance: [null, "triangle_outline"],
  composition: ["diamond", null],
  aggregation: ["diamond_outline", null],
};

/**
 * Relação a partir das pontas atuais. A gravada em customData vence se ainda
 * bate com as pontas; senão, busca reversa (o humano pode ter trocado a ponta
 * no editor). association (sem pontas) só vale se foi gravada: uma seta comum
 * sem ponta não vira association.
 */
export function relationFromArrowheads(
  start: string | null,
  end: string | null,
  stored: unknown,
): DiagramRelation | undefined {
  const matches = (r: DiagramRelation) =>
    RELATION_ARROWHEADS[r][0] === start && RELATION_ARROWHEADS[r][1] === end;
  if (typeof stored === "string" && stored in RELATION_ARROWHEADS) {
    if (matches(stored as DiagramRelation)) return stored as DiagramRelation;
  }
  return (Object.keys(RELATION_ARROWHEADS) as DiagramRelation[]).find(
    (r) => r !== "association" && matches(r),
  );
}

export const isBlockType = (type: string): type is BlockKind =>
  type === "entity" || type === "class";

export const ENTITY_HEADER_BG = "#a5d8ff";
export const CLASS_HEADER_BG = "#ffec99";
// Mesmo BOUND_TEXT_PADDING do Excalidraw: o bound text alinhado à esquerda
// fica em container.x + 5 e quebra linha acima de width - 10.
const BOUND_TEXT_PADDING = 5;
const CELL_PAD_X = 16;
const CELL_PAD_Y = 8;
const MIN_BLOCK_WIDTH = 160;
const EMPTY_COMPARTMENT_HEIGHT = 16;

/** "PK id: uuid" — marcador em texto (emoji não rende bem na Excalifont). */
export function formatField(f: EntityField): string {
  const marks = `${f.pk ? "PK " : ""}${f.fk ? "FK " : ""}`;
  return `${marks}${f.name}${f.type ? `: ${f.type}` : ""}`;
}

export function parseField(line: string): EntityField {
  let rest = line.trim();
  const field: EntityField = { name: "" };
  for (;;) {
    if (rest.startsWith("PK ")) field.pk = true;
    else if (rest.startsWith("FK ")) field.fk = true;
    else break;
    rest = rest.slice(3).trimStart();
  }
  const colon = rest.indexOf(":");
  if (colon >= 0) {
    field.name = rest.slice(0, colon).trim();
    const type = rest.slice(colon + 1).trim();
    if (type) field.type = type;
  } else {
    field.name = rest;
  }
  return field;
}

interface Section {
  key: string;
  text: string | null;
  header: boolean;
}

function sectionsOf(skel: DiagramSkeletonElement): Section[] {
  const header: Section = {
    key: "header",
    text: skel.name ?? skel.label?.text ?? skel.id,
    header: true,
  };
  if (skel.type === "entity") {
    return [
      header,
      ...(skel.fields ?? []).map((f, i) => ({
        key: `f${i}`,
        text: formatField(f),
        header: false,
      })),
    ];
  }
  const join = (lines?: string[]) =>
    lines && lines.length > 0 ? lines.join("\n") : null;
  return [
    header,
    { key: "attrs", text: join(skel.attributes), header: false },
    { key: "methods", text: join(skel.methods), header: false },
  ];
}

const sectionHeight = (s: Section) =>
  s.text === null
    ? EMPTY_COMPARTMENT_HEIGHT
    : textMetrics(s.text).height + CELL_PAD_Y * 2;

export function blockSize(skel: DiagramSkeletonElement): {
  width: number;
  height: number;
} {
  const sections = sectionsOf(skel);
  const widest = Math.max(
    0,
    ...sections.map((s) => (s.text === null ? 0 : textMetrics(s.text).width)),
  );
  return {
    width: Math.max(MIN_BLOCK_WIDTH, Math.ceil(widest) + CELL_PAD_X * 2),
    height: sections.reduce((sum, s) => sum + sectionHeight(s), 0),
  };
}

export const partIdFor = (ownerId: string, key: string) => `${ownerId}__${key}`;

/** Dados do bloco que vão pro customData (reconstrução no elementsToSkeleton). */
function blockData(skel: DiagramSkeletonElement): Record<string, unknown> {
  const name = skel.name ?? skel.label?.text ?? skel.id;
  return skel.type === "entity"
    ? { kind: "entity", name, fields: skel.fields ?? [] }
    : {
        kind: "class",
        name,
        attributes: skel.attributes ?? [],
        methods: skel.methods ?? [],
      };
}

const markPart = <T extends ExBase>(el: T, ownerId: string): T => ({
  ...el,
  groupIds: [ownerId],
  customData: { pitwall: { part: ownerId } },
});

/**
 * Elementos do bloco na posição dada: dono primeiro, depois as partes em
 * ordem de pintura. O dono carrega o pin (meta) e os dados do bloco.
 */
export function buildBlock(
  skel: DiagramSkeletonElement,
  pos: { x: number; y: number },
  meta: { auto: boolean; direction?: DiagramDirection },
): ExElement[] {
  const { width, height } = blockSize(skel);
  const stroke = skel.strokeColor;
  const headerBg =
    skel.backgroundColor ??
    (skel.type === "entity" ? ENTITY_HEADER_BG : CLASS_HEADER_BG);

  const ownerBase = baseElement(
    { id: skel.id, type: "rectangle", backgroundColor: "transparent" },
    pos.x,
    pos.y,
    width,
    height,
  );
  const owner = withPitwallMeta(
    {
      ...ownerBase,
      strokeColor: "transparent",
      roundness: null,
      groupIds: [skel.id],
      customData: { pitwall: blockData(skel) },
    },
    meta,
  );

  const out: ExElement[] = [owner];
  let y = pos.y;
  for (const section of sectionsOf(skel)) {
    const h = sectionHeight(section);
    const cell = markPart(
      {
        ...baseElement(
          {
            id: partIdFor(skel.id, section.key),
            type: "rectangle",
            strokeColor: stroke,
            backgroundColor: section.header ? headerBg : "transparent",
          },
          pos.x,
          y,
          width,
          h,
        ),
        roundness: null,
      },
      skel.id,
    );
    out.push(cell);
    if (section.text !== null) {
      const text = markPart(
        makeTextElement(
          partIdFor(skel.id, `${section.key}__text`),
          section.text,
          0,
          0,
          cell.id,
        ),
        skel.id,
      );
      const aligned: ExText = {
        ...text,
        textAlign: section.header ? "center" : "left",
        verticalAlign: "middle",
        ...(stroke ? { strokeColor: stroke } : {}),
      };
      Object.assign(aligned, boundTextPosition(cell, aligned));
      cell.boundElements = [{ id: aligned.id, type: "text" }];
      out.push(aligned);
    }
    y += h;
  }
  return out;
}

/** Posição de bound text num retângulo, igual ao computeBoundTextPosition. */
export function boundTextPosition(
  container: { x: number; y: number; width: number; height: number },
  text: {
    width: number;
    height: number;
    textAlign: string;
    verticalAlign: string;
  },
): { x: number; y: number } {
  const innerX = container.x + BOUND_TEXT_PADDING;
  const innerY = container.y + BOUND_TEXT_PADDING;
  const maxW = container.width - BOUND_TEXT_PADDING * 2;
  const maxH = container.height - BOUND_TEXT_PADDING * 2;
  const x =
    text.textAlign === "left"
      ? innerX
      : text.textAlign === "right"
        ? innerX + maxW - text.width
        : innerX + maxW / 2 - text.width / 2;
  const y =
    text.verticalAlign === "top"
      ? innerY
      : text.verticalAlign === "bottom"
        ? innerY + maxH - text.height
        : innerY + maxH / 2 - text.height / 2;
  return { x, y };
}

/** Dono do bloco que esta parte compõe, ou undefined se não for parte. */
export function partOwner(el: { customData?: Record<string, unknown> }) {
  const meta = el.customData?.pitwall as { part?: unknown } | undefined;
  return typeof meta?.part === "string" ? meta.part : undefined;
}

export function blockKind(el: {
  customData?: Record<string, unknown>;
}): BlockKind | undefined {
  const kind = (el.customData?.pitwall as { kind?: unknown } | undefined)?.kind;
  return kind === "entity" || kind === "class" ? kind : undefined;
}

/**
 * Skeleton do bloco a partir da cena. Os textos das partes vencem o
 * customData: o humano pode ter editado um campo com duplo clique.
 */
export function blockToSkeleton(
  owner: ExBase,
  textOf: (partId: string) => string | undefined,
): DiagramSkeletonElement {
  const meta = (owner.customData?.pitwall ?? {}) as Record<string, unknown>;
  const kind = blockKind(owner)!;
  const name =
    textOf(partIdFor(owner.id, "header__text")) ??
    (typeof meta.name === "string" ? meta.name : owner.id);
  if (kind === "entity") {
    const stored = Array.isArray(meta.fields)
      ? (meta.fields as EntityField[])
      : [];
    const fields: EntityField[] = [];
    for (let i = 0; ; i++) {
      const line = textOf(partIdFor(owner.id, `f${i}__text`));
      if (line === undefined) break;
      fields.push(parseField(line));
    }
    return {
      id: owner.id,
      type: "entity",
      name,
      fields: fields.length > 0 ? fields : stored,
    };
  }
  const lines = (key: string, fallback: unknown): string[] => {
    const text = textOf(partIdFor(owner.id, `${key}__text`));
    if (text !== undefined) return text.split("\n");
    return Array.isArray(fallback) ? (fallback as string[]) : [];
  };
  return {
    id: owner.id,
    type: "class",
    name,
    attributes: lines("attrs", meta.attributes),
    methods: lines("methods", meta.methods),
  };
}
