// What the designer sees: Home at 100% around the hero, the preview walk
// Home → Cardápio → Contato, the inspector with a card selected and Layers
// expanded, the Ask Claude composer, and the Design area under all 4 themes.
import { screenshot } from "../../driver/capture";
import {
  clickAt,
  nodeCenterOnScreen,
  pwSelector,
  waitForArtboardFrame,
  waitForValue,
} from "../../driver/design";
import { openSettings } from "../../driver/nav";
import type { ArtboardKey } from "../design-breads-do-breno/session";
import { PRESETS } from "../../../src/lib/themes";
import { clickNode, fitAll, selectedTag, SHOT, type FinalCtx } from "./ctx";

export async function stepHomeAt100(ctx: FinalCtx): Promise<void> {
  await fitAll(ctx);
  // Ctrl+click on the hero's padding selects the section itself.
  await clickNode(ctx, "home", "Hero", { ctrl: true, corner: true });
  const tag = await selectedTag(ctx);
  const zoomButton = ctx.page.getByTitle("Zoom 100% na seleção (Ctrl+1)");
  await zoomButton.click();
  await ctx.page.waitForTimeout(900);
  await screenshot(ctx.page, `${SHOT}-05-home-100`);
  const label = (await zoomButton.textContent())?.trim();
  ctx.check(
    "3 Home hero selected and at 100%",
    /Hero$/.test(tag) && label === "100%",
    `selected=${tag} zoom=${label}`,
  );
}

export async function stepPreviewFlow(ctx: FinalCtx): Promise<void> {
  const { page, doc } = ctx;
  await fitAll(ctx);
  await clickNode(ctx, "home", "Headline");
  await page.getByTestId("design-preview").click();
  const root = page.getByTestId("design-preview-root");
  await root.waitFor({ state: "visible", timeout: 5000 });
  const select = page.getByTestId("design-preview-artboard-select");

  const go = async (
    from: ArtboardKey,
    fromTitle: string,
    nodeName: string,
    to: ArtboardKey,
  ) => {
    const frame = await waitForArtboardFrame(page, doc.ids[from], {
      mode: "preview",
    });
    await page.waitForTimeout(500);
    const id = await doc.findId(doc.ids[from], nodeName);
    const p = await nodeCenterOnScreen(
      page,
      frame,
      `iframe[title="Preview: ${fromTitle}"]`,
      doc.widths[from],
      pwSelector(id),
    );
    await clickAt(page, p);
    const current = await waitForValue(
      () => select.inputValue(),
      doc.ids[to],
      3000,
    );
    await page.waitForTimeout(700);
    return current === doc.ids[to];
  };

  await page.waitForTimeout(600);
  const toMenu = await go("home", "Home", "Nav Cardápio", "menu");
  await screenshot(page, `${SHOT}-06-preview-cardapio`);
  const toContact = await go("menu", "Cardápio", "Nav Contato", "contact");
  await screenshot(page, `${SHOT}-07-preview-contato`);
  ctx.check(
    "4 preview Home → Cardápio → Contato via links",
    toMenu && toContact,
    `menu=${toMenu} contact=${toContact}`,
  );
  await page.keyboard.press("Escape");
  const closed = await root
    .waitFor({ state: "hidden", timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  ctx.check("4 Esc leaves the preview", closed);
}

export async function stepInspectorLayers(ctx: FinalCtx): Promise<void> {
  await fitAll(ctx);
  // Ctrl+click picks the deepest node under the pointer: aim at the card's
  // padding (top-right corner) so the article itself is selected, not its h3.
  await clickNode(ctx, "home", "Destaque forno", {
    ctrl: true,
    dx: 180,
    dy: -78,
  });
  const tag = await selectedTag(ctx);
  const aside = ctx.page.locator("aside").first();
  // dnd-kit stamps aria-disabled on non-draggable rows (the artboard root):
  // Playwright refuses a normal click on the chevron inside them, force it.
  const expand = async (label: string) => {
    const row = aside
      .locator(`span[title="${label}"]`)
      .first()
      .locator("xpath=..");
    await row.locator("button").first().click({ force: true });
    await ctx.page.waitForTimeout(150);
  };
  await expand("Highlights");
  await expand("Hero");
  await ctx.page.waitForTimeout(400);
  await screenshot(ctx.page, `${SHOT}-08-inspector-layers`);
  const rows = await aside.locator("span[title]").count();
  const inspector = ctx.page.locator("aside").last();
  const sections = await inspector
    .getByText(/Layout|Preenchimento|Tipografia/)
    .first()
    .isVisible()
    .catch(() => false);
  ctx.check(
    "5 card selected, inspector sections visible, layers expanded",
    tag.startsWith("article") && sections && rows >= 9,
    `selected=${tag} sections=${sections} rows=${rows}`,
  );
}

export async function stepComposer(ctx: FinalCtx): Promise<void> {
  await ctx.page.keyboard.press("/");
  const textarea = ctx.page.getByPlaceholder(/O que Claude deve fazer/);
  const opened = await textarea
    .waitFor({ state: "visible", timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  const chips = await ctx.page.locator('[title*="#"]').count();
  await ctx.page.waitForTimeout(300);
  await screenshot(ctx.page, `${SHOT}-09-composer`);
  ctx.check(
    "5 '/' opens the composer with a selection chip",
    opened && chips >= 1,
    `chips=${chips}`,
  );
  await ctx.page.getByTitle("Fechar (Esc)").click();
  await ctx.page.waitForTimeout(300);
}

interface ChromeSample {
  layerColor: string;
  asideBg: string;
  contrast: number;
}

// Contrast between a Layers row label and its panel background (WCAG ratio).
async function sampleChrome(ctx: FinalCtx): Promise<ChromeSample> {
  return ctx.page.evaluate(() => {
    const aside = document.querySelector("aside");
    const label = aside?.querySelector("span[title]");
    const parse = (css: string) => {
      const m = css.match(/\d+(\.\d+)?/g)?.map(Number) ?? [0, 0, 0];
      return m.slice(0, 3);
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const layerColor = label ? getComputedStyle(label).color : "none";
    const asideBg = aside ? getComputedStyle(aside).backgroundColor : "none";
    const l1 = lum(parse(layerColor));
    const l2 = lum(parse(asideBg));
    const contrast = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    return { layerColor, asideBg, contrast: Math.round(contrast * 10) / 10 };
  });
}

async function pageBackground(ctx: FinalCtx): Promise<string> {
  const frame = await waitForArtboardFrame(ctx.page, ctx.doc.ids.home);
  return frame.evaluate(() => {
    const el = document.querySelector('[data-name="Page"]');
    return el ? getComputedStyle(el).backgroundColor : "missing";
  });
}

export async function stepThemes(ctx: FinalCtx): Promise<void> {
  const { page } = ctx;
  const baseline = await pageBackground(ctx);
  const results: string[] = [];
  let allOk = true;
  for (const preset of PRESETS) {
    await openSettings(page);
    await page.getByRole("button", { name: "Aparência" }).click();
    await page.getByRole("button", { name: preset.label, exact: true }).click();
    await page.waitForTimeout(200);
    await page.getByRole("button", { name: "Fechar", exact: true }).click();
    await page.waitForTimeout(500);
    await screenshot(page, `${SHOT}-10-theme-${preset.id}`);
    const chrome = await sampleChrome(ctx);
    const artboardBg = await pageBackground(ctx);
    const ok = chrome.contrast >= 4.5 && artboardBg === baseline;
    allOk &&= ok;
    results.push(
      `${preset.id}/${preset.label}: contrast=${chrome.contrast} (${chrome.layerColor} on ${chrome.asideBg}) artboard=${artboardBg === baseline ? "unchanged" : artboardBg}`,
    );
  }
  ctx.log("themes:", results.join(" | "));
  ctx.check(
    "6 four themes: chrome contrast ≥ 4.5, artboards unchanged",
    allOk,
    results.join(" | "),
  );
}
