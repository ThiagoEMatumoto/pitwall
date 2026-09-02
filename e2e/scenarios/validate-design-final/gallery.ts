// Writes a local HTML gallery of the ds-final-* screenshots with captions.
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SHOT } from "./ctx";

const CAPTIONS: Record<string, string> = {
  "01-canvas":
    "Canvas com o doc Breads do Breno (tokens + 4 artboards + links), ajustado à tela",
  "02-agent-inplace":
    "design_styles_update no hero da Home — indicador in-place + badge na toolbar",
  "02b-agent-create":
    "design_artboard_create — badge na toolbar, sem véu nos artboards existentes",
  "03-agent-writing":
    "design_write_html no artboard novo Promoções (1440×600) — durante a escrita",
  "04-agent-done": 'design_nodes_finish — "Claude terminou" antes de sumir',
  "05-home-100": "Home a 100% centrada no hero selecionado (Ctrl+1)",
  "06-preview-cardapio": "Preview: Home → Cardápio pelo link do menu",
  "07-preview-contato": "Preview: Cardápio → Contato pelo link do menu",
  "08-inspector-layers":
    'Card "Destaque forno" selecionado, inspector à direita, Layers expandido',
  "09-composer": 'Composer Ask Claude aberto com "/" e chip da seleção',
  "10-theme-slate": "Tema Vácuo (padrão)",
  "10-theme-forest": "Tema Sinal",
  "10-theme-ocean": "Tema Gelo",
  "10-theme-ember": "Tema Papaia",
};

export function writeGallery(shotsDir: string): string {
  const files = readdirSync(shotsDir)
    .filter((f) => f.startsWith(`${SHOT}-`) && f.endsWith(".png"))
    .sort();
  const figures = files
    .map((f) => {
      const key = f.slice(SHOT.length + 1, -4);
      const caption = CAPTIONS[key] ?? key;
      return `<figure><img src="${f}" alt="${key}" loading="lazy"><figcaption><b>${key}</b> — ${caption}</figcaption></figure>`;
    })
    .join("\n");
  const html = `<!doctype html>
<meta charset="utf-8">
<title>Design Studio — evidência visual final</title>
<style>
  body { margin: 0; padding: 24px; background: #111; color: #ddd; font: 14px/1.4 system-ui, sans-serif }
  h1 { font-size: 18px; margin: 0 0 16px }
  figure { margin: 0 0 32px }
  img { display: block; max-width: 100%; border: 1px solid #333; border-radius: 6px }
  figcaption { margin-top: 8px; color: #aaa }
</style>
<h1>Design Studio — ${files.length} screenshots (${SHOT}-*)</h1>
${figures}
`;
  const out = join(shotsDir, `${SHOT}-gallery.html`);
  writeFileSync(out, html);
  return out;
}
