import type { Page } from "playwright";
import type { McpClient } from "../../driver/mcp";
import {
  clickAt,
  nodeBoxInFrame,
  nodeCenterOnScreen,
  pwSelector,
  waitForArtboardFrame,
} from "../../driver/design";
import type { ArtboardKey } from "../design-breads-do-breno/session";
import type { BuiltDoc } from "./build";

export const SHOT = "ds-final";

export interface FinalCtx {
  page: Page;
  mcp: McpClient;
  doc: BuiltDoc;
  check: (name: string, ok: boolean, detail?: string) => boolean;
  log: (...a: unknown[]) => void;
}

export async function fitAll(ctx: FinalCtx): Promise<void> {
  await ctx.page.getByTitle("Ajustar à tela (Ctrl+0)").click();
  await ctx.page.waitForTimeout(700);
}

// Clicks a node (by data-name) inside an artboard's edit frame. `corner`
// aims at the node's top-left padding so a Ctrl+click picks the node itself
// rather than its first child.
export async function clickNode(
  ctx: FinalCtx,
  key: ArtboardKey,
  name: string,
  opts: { ctrl?: boolean; dx?: number; dy?: number; corner?: boolean } = {},
): Promise<void> {
  const artboardId = ctx.doc.ids[key];
  const frame = await waitForArtboardFrame(ctx.page, artboardId);
  const id = await ctx.doc.findId(artboardId, name);
  let dx = opts.dx ?? 0;
  let dy = opts.dy ?? 0;
  if (opts.corner) {
    const box = await nodeBoxInFrame(frame, pwSelector(id));
    if (box) {
      dx = -box.w / 2 + 12;
      dy = -box.h / 2 + 12;
    }
  }
  const p = await nodeCenterOnScreen(
    ctx.page,
    frame,
    `[data-artboard="${artboardId}"]`,
    ctx.doc.widths[key],
    pwSelector(id),
    { dx, dy },
  );
  await clickAt(ctx.page, p, { ctrl: opts.ctrl });
  await ctx.page.waitForTimeout(400);
}

export async function selectedTag(ctx: FinalCtx): Promise<string> {
  const sel = await ctx.mcp.call<{
    nodes?: Array<{ tag: string; name?: string }>;
  }>("design_selection_get", { docId: ctx.doc.docId });
  return sel.nodes?.[0]
    ? `${sel.nodes[0].tag}:${sel.nodes[0].name ?? ""}`
    : "none";
}
