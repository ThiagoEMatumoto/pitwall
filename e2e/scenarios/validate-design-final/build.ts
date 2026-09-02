// Builds the Breads do Breno document through the MCP HTTP tools (the same
// path a Claude session uses): tokens, four artboards, prototype links. The
// HTML/brand content is the designer scenario's own — imported, not copied.
import type { McpClient } from "../../driver/mcp";
import { FONTS, TOKENS } from "../design-breads-do-breno/brand";
import {
  HOME_DESKTOP_HTML,
  HOME_MOBILE_HTML,
} from "../design-breads-do-breno/content-home";
import {
  CONTACT_HTML,
  MENU_HTML,
} from "../design-breads-do-breno/content-pages";
import type { ArtboardKey } from "../design-breads-do-breno/session";

export interface ArtboardSpec {
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  html: string;
}

export const SPECS: Record<ArtboardKey, ArtboardSpec> = {
  home: {
    name: "Home",
    width: 1440,
    height: 900,
    x: 0,
    y: 0,
    html: HOME_DESKTOP_HTML,
  },
  mobile: {
    name: "Home mobile",
    width: 390,
    height: 844,
    x: 1520,
    y: 0,
    html: HOME_MOBILE_HTML,
  },
  menu: {
    name: "Cardápio",
    width: 1440,
    height: 900,
    x: 0,
    y: 1000,
    html: MENU_HTML,
  },
  contact: {
    name: "Contato",
    width: 1440,
    height: 900,
    x: 1520,
    y: 1000,
    html: CONTACT_HTML,
  },
};
export const KEYS = Object.keys(SPECS) as ArtboardKey[];

// Prototype links: node data-name → target artboard (mirrors the designer run).
const LINKS: Record<ArtboardKey, Array<[string, ArtboardKey]>> = {
  home: [
    ["Logo", "home"],
    ["Nav Cardápio", "menu"],
    ["Nav Contato", "contact"],
    ["Nav CTA", "contact"],
    ["CTA", "menu"],
    ["CTA secundário", "contact"],
  ],
  mobile: [
    ["Logo", "mobile"],
    ["CTA", "menu"],
  ],
  menu: [
    ["Logo", "home"],
    ["Nav Cardápio", "menu"],
    ["Nav Contato", "contact"],
    ["Nav CTA", "contact"],
    ["CTA encomenda", "contact"],
  ],
  contact: [
    ["Logo", "home"],
    ["Nav Cardápio", "menu"],
    ["Nav Contato", "contact"],
    ["Nav CTA", "contact"],
  ],
};
export const LINK_COUNT = Object.values(LINKS).reduce(
  (n, l) => n + l.length,
  0,
);

interface NodeItem {
  id: string;
  name?: string;
  tag: string;
  childCount: number;
}

export interface BuiltDoc {
  docId: string;
  ids: Record<ArtboardKey, string>;
  widths: Record<ArtboardKey, number>;
  links: number;
  warnings: string[];
  // BFS through design_children_get: ids always come from a read.
  findId: (artboardId: string, name: string) => Promise<string>;
}

export async function buildDocument(mcp: McpClient): Promise<BuiltDoc> {
  const created = await mcp.call("design_document_create", {
    title: "Breads do Breno",
    fonts: FONTS,
  });
  const docId: string = created.document.id;
  await mcp.call("design_tokens_set", { docId, tokens: TOKENS, fonts: FONTS });

  const ids = {} as Record<ArtboardKey, string>;
  for (const key of KEYS) {
    const s = SPECS[key];
    const ab = await mcp.call("design_artboard_create", {
      docId,
      name: s.name,
      width: s.width,
      height: s.height,
      x: s.x,
      y: s.y,
    });
    ids[key] = ab.artboard.id;
  }
  const warnings: string[] = [];
  for (const key of KEYS) {
    const written = await mcp.call("design_write_html", {
      artboardId: ids[key],
      html: SPECS[key].html,
      summary: `Primeira versão: ${SPECS[key].name}`,
    });
    for (const w of (written.warnings ?? []) as string[])
      warnings.push(`${SPECS[key].name}: ${w}`);
  }

  const cache = new Map<string, string>();
  async function findId(artboardId: string, name: string): Promise<string> {
    const cacheKey = `${artboardId}:${name}`;
    const hit = cache.get(cacheKey);
    if (hit) return hit;
    const queue: Array<string | null> = [null];
    while (queue.length) {
      const parent = queue.shift() ?? null;
      const res = await mcp.call<{ items: NodeItem[] }>("design_children_get", {
        artboardId,
        nodeId: parent,
      });
      for (const it of res.items) {
        if (it.name === name) {
          cache.set(cacheKey, it.id);
          return it.id;
        }
        if (it.childCount > 0) queue.push(it.id);
      }
    }
    throw new Error(`node "${name}" not found in artboard ${artboardId}`);
  }

  let links = 0;
  for (const key of KEYS) {
    for (const [name, target] of LINKS[key]) {
      const nodeId = await findId(ids[key], name);
      await mcp.call("design_link_set", {
        artboardId: ids[key],
        nodeId,
        targetArtboardId: ids[target],
        transition: key === "mobile" ? "push" : "fade",
      });
      links++;
    }
  }
  const widths = Object.fromEntries(
    KEYS.map((k) => [k, SPECS[k].width]),
  ) as Record<ArtboardKey, number>;
  return { docId, ids, widths, links, warnings, findId };
}
