// The in-place "Claude is editing" indicator, exercised through real tool
// calls: styles on the Home hero, a fresh artboard written from scratch, then
// design_nodes_finish. Tool handlers run synchronously in main, so 'start' and
// 'end' reach the renderer back to back; the overlay holds the active stage
// for MIN_ACTIVE_MS, and the calls are fired without await while the DOM is
// polled every few ms to catch that window.
import { screenshot } from "../../driver/capture";
import { desktopHeader } from "../design-breads-do-breno/content-home";
import { SHOT, type FinalCtx } from "./ctx";

const PROMO_HTML = `
<div data-name="Page" style="display:flex;flex-direction:column;width:100%;height:100%;overflow:hidden;background:var(--color-bg);color:var(--color-ink)">
  ${desktopHeader()}
  <section data-name="Promo" style="display:flex;flex:1;align-items:center;justify-content:space-between;gap:48px;padding:48px 96px">
    <div data-name="Promo copy" style="display:flex;flex-direction:column;gap:14px;max-width:560px">
      <span data-name="Eyebrow" style="font-family:var(--font-body);font-size:13px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:var(--color-crust)">Promoções da semana</span>
      <h1 data-name="Headline" style="margin:0;font-family:var(--font-display);font-size:48px;line-height:1.05;color:var(--color-ink)">Leve 3 pães de fermentação, pague 2.</h1>
      <p data-name="Lead" style="margin:0;font-family:var(--font-body);font-size:18px;line-height:1.5;color:var(--color-muted)">De terça a quinta, antes das 10h. Só no balcão, enquanto durar a fornada.</p>
      <a data-name="CTA" href="#" style="display:inline-flex;width:fit-content;padding:14px 24px;border-radius:var(--radius-pill);background:var(--color-crust);color:var(--color-white);font-family:var(--font-body);font-size:15px;font-weight:600;text-decoration:none">Ver o cardápio</a>
    </div>
    <div data-name="Promo visual" style="display:flex;align-items:center;justify-content:center;width:420px;height:320px;border-radius:var(--radius-lg);background:var(--color-crust-soft)">
      <span style="font-family:var(--font-display);font-size:120px;color:var(--color-bread)">3×2</span>
    </div>
  </section>
</div>`;

interface OverlaySnapshot {
  veils: number;
  skeletons: number;
  pills: string[];
  badge: string | null;
}

async function readOverlay(ctx: FinalCtx): Promise<OverlaySnapshot> {
  return ctx.page.evaluate(() => {
    const pills = [
      ...document.querySelectorAll(".pointer-events-none[aria-hidden] span"),
    ]
      .map((el) => el.textContent?.trim() ?? "")
      .filter((t) => t.startsWith("Claude"));
    const badge =
      document.querySelector(".pw-design-shimmer")?.textContent?.trim() ?? null;
    return {
      veils: document.querySelectorAll(".pw-agent-veil").length,
      skeletons: document.querySelectorAll(".pw-agent-skeleton").length,
      pills,
      badge,
    };
  });
}

// Polls until the overlay shows something (or the deadline passes) and
// returns the first non-empty snapshot plus the one taken after the screenshot.
async function captureWhileVisible(
  ctx: FinalCtx,
  shot: string,
  timeoutMs = 2500,
): Promise<{
  first: OverlaySnapshot;
  atShot: OverlaySnapshot;
  waitedMs: number;
}> {
  const started = Date.now();
  let first = await readOverlay(ctx);
  while (
    first.pills.length === 0 &&
    first.veils === 0 &&
    Date.now() - started < timeoutMs
  ) {
    await new Promise((r) => setTimeout(r, 8));
    first = await readOverlay(ctx);
  }
  const waitedMs = Date.now() - started;
  await screenshot(ctx.page, shot);
  const atShot = await readOverlay(ctx);
  return { first, atShot, waitedMs };
}

const fmt = (s: OverlaySnapshot) =>
  `veils=${s.veils} skeletons=${s.skeletons} pills=${JSON.stringify(s.pills)} badge=${JSON.stringify(s.badge)}`;

export async function stepAgentInPlace(ctx: FinalCtx): Promise<string> {
  const { mcp, doc, page } = ctx;
  const heroId = await doc.findId(doc.ids.home, "Hero");

  // 2a. styles on the hero — fire and poll
  const styles = mcp.call("design_styles_update", {
    artboardId: doc.ids.home,
    items: [{ id: heroId, style: { background: "var(--color-crust-soft)" } }],
    summary: "Hero com fundo quente",
  });
  const a = await captureWhileVisible(ctx, `${SHOT}-02-agent-inplace`);
  await styles;
  ctx.log(
    `02 styles: first(${a.waitedMs}ms) ${fmt(a.first)} | at shot ${fmt(a.atShot)}`,
  );
  const heroPill = [...a.first.pills, ...a.atShot.pills].some((t) =>
    /Hero/.test(t),
  );
  ctx.check(
    "2a in-place pill appears on the Hero during/after design_styles_update",
    a.first.pills.length > 0 && heroPill,
    fmt(a.first),
  );
  ctx.check(
    "2a active stage visible: veil + 'Claude · ajustando estilo · Hero'",
    a.first.veils > 0 && a.first.pills.some((t) => /ajustando estilo · Hero/.test(t)),
    fmt(a.first),
  );
  ctx.check(
    "2a toolbar badge names the action (Claude · ajustando estilo · Hero)",
    /ajustando estilo/.test(a.atShot.badge ?? "") &&
      /Hero/.test(a.atShot.badge ?? ""),
    `badge=${a.atShot.badge}`,
  );
  const sawActive = [a.first, a.atShot].some(
    (s) => s.veils > 0 || s.pills.some((t) => /ajustando estilo/.test(t)),
  );
  ctx.log(`02 active (veil/"ajustando estilo") state observed: ${sawActive}`);

  // 2b. new artboard + write_html replace — fire and poll for the skeleton.
  // Waits cover hold + done + fade (≈2.3s) so no earlier pill lingers.
  await page.waitForTimeout(2600);
  const create = mcp.call("design_artboard_create", {
    docId: doc.docId,
    name: "Promoções",
    width: 1440,
    height: 600,
    x: 0,
    y: 2000,
  });
  // Doc-level call: the badge names it, but nothing on the page is veiled.
  const started = Date.now();
  let atCreate = await readOverlay(ctx);
  while (atCreate.badge === null && Date.now() - started < 2500) {
    await new Promise((r) => setTimeout(r, 8));
    atCreate = await readOverlay(ctx);
  }
  await screenshot(ctx.page, `${SHOT}-02b-agent-create`);
  const promo = await create;
  const promoId: string = promo.artboard.id;
  ctx.log(`02b artboard_create: ${fmt(atCreate)}`);
  ctx.check(
    "2b artboard_create: badge shows, existing artboards get no veil",
    atCreate.badge !== null && atCreate.veils === 0,
    fmt(atCreate),
  );
  await page.waitForTimeout(2600);
  const listed = await page
    .locator("aside")
    .first()
    .getByText("Promoções", { exact: true })
    .isVisible()
    .catch(() => false);
  ctx.check("2b empty artboard created by Claude is adopted by the open doc", listed);
  await page.getByTitle("Ajustar à tela (Ctrl+0)").click();
  await page.waitForTimeout(600);
  const write = mcp.call("design_write_html", {
    artboardId: promoId,
    html: PROMO_HTML,
    summary: "Promoções: primeira versão",
  });
  const b = await captureWhileVisible(ctx, `${SHOT}-03-agent-writing`);
  await write;
  ctx.log(
    `03 write_html: first(${b.waitedMs}ms) ${fmt(b.first)} | at shot ${fmt(b.atShot)}`,
  );
  ctx.check(
    "2b in-place pill appears on Promoções during/after design_write_html",
    [...b.first.pills, ...b.atShot.pills].some((t) =>
      /Promoções|terminou/.test(t),
    ),
    fmt(b.first),
  );
  ctx.check(
    "2b writing stage visible: 'Claude está escrevendo Promoções…'",
    [b.first, b.atShot].some((s) => s.pills.some((t) => /escrevendo Promoções/.test(t))),
    fmt(b.first),
  );
  const sawWriting = [b.first, b.atShot].some(
    (s) =>
      s.skeletons > 0 || s.pills.some((t) => /escrevendo Promoções/.test(t)),
  );
  ctx.log(
    `03 writing (skeleton/"escrevendo Promoções…") state observed: ${sawWriting}`,
  );

  // 2c. finish → "Claude terminou", then nothing
  await page.waitForTimeout(2600);
  const before = await readOverlay(ctx);
  ctx.check(
    "2c badge persists until design_nodes_finish",
    before.badge !== null,
    `badge=${before.badge}`,
  );
  await mcp.call("design_nodes_finish", {
    artboardId: doc.ids.home,
    summary: "Hero revisado",
  });
  await mcp.call("design_nodes_finish", {
    artboardId: promoId,
    summary: "Promoções pronta",
  });
  const c = await captureWhileVisible(ctx, `${SHOT}-04-agent-done`, 1500);
  ctx.log(
    `04 finish: first(${c.waitedMs}ms) ${fmt(c.first)} | at shot ${fmt(c.atShot)}`,
  );
  await page.waitForTimeout(2000);
  const after = await readOverlay(ctx);
  ctx.check(
    "2c overlay + badge gone 2s after finish",
    after.veils === 0 &&
      after.skeletons === 0 &&
      after.pills.length === 0 &&
      after.badge === null,
    fmt(after),
  );
  return promoId;
}
