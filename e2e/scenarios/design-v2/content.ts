// The long Breads do Breno landing (1440 × flow): header, six stacked
// sections and footer, well past 4000px so the flow artboard, the tiled
// capture and the in-view entrances all have something to work on. Brand,
// header and footer are the designer scenario's own (imported, not copied).
import { ICONS, loafIllustration } from '../design-breads-do-breno/brand'
import { desktopFooter, desktopHeader } from '../design-breads-do-breno/content-home'

const BODY = 'font-family:var(--font-body)'
const DISPLAY = 'font-family:var(--font-display)'
const PILL = `display:inline-flex;align-items:center;gap:10px;padding:16px 28px;border-radius:var(--radius-pill);text-decoration:none;${BODY};font-size:16px;font-weight:700`

// Node names the scenario targets (motion, links, selection). Header names
// ("Header", "Nav Cardápio") come from desktopHeader() and match the Cardápio
// artboard, which is what Smart Animate pairs on.
export const LANDING_NODES = {
  hero: 'Hero',
  heroCta: 'CTA',
  cards: 'Cards',
  marquee: 'Faixa',
  parallaxImage: 'Imagem processo',
  menuCta: 'CTA cardápio',
  navMenu: 'Nav Cardápio',
  header: 'Header',
} as const

// min-heights make the total deterministic: 84 + 760 + 640 + 140 + 900 + 800 + 700 + 96 = 4120.
export const LANDING_MIN_HEIGHT = 4120

function eyebrow(text: string): string {
  return `<span style="display:inline-flex;align-items:center;gap:10px;${BODY};font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--color-olive)">${ICONS.wheat(18)} ${text}</span>`
}

function h2(name: string, text: string): string {
  return `<h2 data-name="${name}" style="margin:0;${DISPLAY};font-size:48px;line-height:1.05;font-weight:600;letter-spacing:-0.02em;color:var(--color-ink)">${text}</h2>`
}

function card(name: string, iconSvg: string, title: string, text: string): string {
  return `
    <article data-name="${name}" style="display:flex;flex-direction:column;gap:14px;flex:1;padding:32px;background:var(--color-white);border-radius:var(--radius-md);box-shadow:var(--shadow-card)">
      <span style="display:flex;width:44px;height:44px;align-items:center;justify-content:center;border-radius:var(--radius-sm);background:var(--color-surface);color:var(--color-crust)">${iconSvg}</span>
      <h3 style="margin:0;${DISPLAY};font-size:24px;font-weight:600;color:var(--color-ink)">${title}</h3>
      <p style="margin:0;${BODY};font-size:16px;line-height:1.55;color:var(--color-muted)">${text}</p>
    </article>`
}

function hero(): string {
  return `
  <section data-name="${LANDING_NODES.hero}" style="display:flex;align-items:center;justify-content:space-between;gap:64px;min-height:760px;padding:64px 72px">
    <div data-name="Hero copy" style="display:flex;flex-direction:column;gap:24px;max-width:640px">
      ${eyebrow('Padaria artesanal · Fermentação natural')}
      <h1 data-name="Headline" style="margin:0;${DISPLAY};font-size:76px;line-height:1.02;font-weight:600;letter-spacing:-0.02em;color:var(--color-ink)">Pão de verdade, saído do forno todo dia às 7h.</h1>
      <p data-name="Lead" style="margin:0;${BODY};font-size:19px;line-height:1.55;color:var(--color-muted);max-width:540px">Fermentação natural de 36 horas, farinha moída na pedra e forno a lenha. Sem melhoradores, sem pressa — só farinha, água, sal e tempo.</p>
      <div data-name="Actions" style="display:flex;align-items:center;gap:16px;margin-top:8px">
        <a data-name="${LANDING_NODES.heroCta}" href="#cardapio" style="${PILL};background:var(--color-crust);color:var(--color-ink)">Ver o cardápio de hoje ${ICONS.arrow(18)}</a>
        <a data-name="CTA secundário" href="#processo" style="${PILL};border:1.5px solid var(--color-line);color:var(--color-ink)">Como fazemos</a>
      </div>
    </div>
    <div data-name="Hero visual" style="display:flex;align-items:center;justify-content:center;flex-shrink:0;width:520px;height:420px;border-radius:var(--radius-lg);background:var(--color-surface)">${loafIllustration(440)}</div>
  </section>`
}

function highlights(): string {
  return `
  <section data-name="Destaques" style="display:flex;flex-direction:column;gap:40px;min-height:640px;padding:72px;background:var(--color-surface)">
    <div style="display:flex;flex-direction:column;gap:12px;max-width:720px">
      ${eyebrow('Por que o nosso pão é diferente')}
      ${h2('Destaques título', 'Três coisas que não abrimos mão.')}
    </div>
    <div data-name="${LANDING_NODES.cards}" style="display:flex;gap:24px">
      ${card('Card fermentação', ICONS.clock(22), '36 horas de fermentação', 'O levain trabalha devagar, a massa ganha sabor e o pão fica mais leve de digerir.')}
      ${card('Card forno', ICONS.fire(22), 'Forno a lenha', 'Casca grossa e crocante, miolo úmido. A lenha é de eucalipto de manejo local.')}
      ${card('Card farinha', ICONS.stone(22), 'Farinha de pedra', 'Moída na semana, com o gérmen. Vem de moinhos a menos de 200 km daqui.')}
    </div>
  </section>`
}

function marquee(): string {
  const words = [
    'Fornada às 7h',
    'Fornada às 15h',
    'Levain desde 2019',
    'Sem melhoradores',
    'Forno a lenha',
  ]
  const text = words.map((w) => `${w} &nbsp;·&nbsp; `).join('')
  return `
  <section data-name="${LANDING_NODES.marquee}" style="display:flex;align-items:center;min-height:140px;padding:0 72px;background:var(--color-bread);color:var(--color-crust-soft);${DISPLAY};font-size:34px;font-weight:600;letter-spacing:-0.01em">
    <span data-name="Faixa texto" style="white-space:nowrap">${text}</span>
  </section>`
}

function process(): string {
  const steps = [
    ['1', 'Autólise', 'Farinha e água descansam uma hora antes do sal e do levain.'],
    ['2', 'Dobras', 'Quatro séries de dobras ao longo de três horas, sem sova.'],
    ['3', 'Frio', 'Vinte e quatro horas na câmara fria: é aí que o sabor aparece.'],
    ['4', 'Forno', 'Vapor nos primeiros dez minutos, depois calor seco até a casca cantar.'],
  ]
    .map(
      ([n, title, text]) => `
      <li data-name="Passo ${n}" style="display:flex;gap:20px;padding:20px 0;border-top:1px solid var(--color-line)">
        <span style="flex-shrink:0;width:40px;height:40px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:var(--color-crust);color:var(--color-ink);${BODY};font-weight:700">${n}</span>
        <div style="display:flex;flex-direction:column;gap:6px">
          <span style="${DISPLAY};font-size:24px;font-weight:600;color:var(--color-ink)">${title}</span>
          <span style="${BODY};font-size:16px;line-height:1.5;color:var(--color-muted)">${text}</span>
        </div>
      </li>`,
    )
    .join('')
  return `
  <section data-name="Processo" style="display:flex;align-items:center;gap:72px;min-height:900px;padding:96px 72px">
    <div data-name="${LANDING_NODES.parallaxImage}" style="display:flex;align-items:center;justify-content:center;flex-shrink:0;width:600px;height:640px;border-radius:var(--radius-lg);background:var(--color-surface-strong);overflow:hidden">${loafIllustration(560)}</div>
    <div style="display:flex;flex-direction:column;gap:28px;flex:1">
      ${eyebrow('O processo')}
      ${h2('Processo título', 'Quarenta horas entre a farinha e o balcão.')}
      <ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column">${steps}</ul>
    </div>
  </section>`
}

function menuTeaser(): string {
  const items = [
    ['Country loaf', 'Levain, farinha branca de pedra e 12% integral', 'R$ 32'],
    ['Integral 100%', 'Trigo integral moído na semana, casca grossa', 'R$ 34'],
    ['Focaccia de alecrim', 'Azeite, sal grosso e alecrim do quintal', 'R$ 26'],
    ['Baguete', 'Poolish de 16 horas, crocante até a tarde', 'R$ 14'],
  ]
    .map(
      ([name, note, price]) => `
      <article data-name="Produto ${name}" style="display:flex;flex-direction:column;gap:10px;padding:28px;background:var(--color-white);border-radius:var(--radius-md);box-shadow:var(--shadow-card)">
        <span style="${DISPLAY};font-size:26px;font-weight:600;color:var(--color-ink)">${name}</span>
        <span style="${BODY};font-size:15px;line-height:1.5;color:var(--color-muted)">${note}</span>
        <span style="margin-top:auto;${BODY};font-size:18px;font-weight:700;color:var(--color-bread)">${price}</span>
      </article>`,
    )
    .join('')
  return `
  <section data-name="Cardápio" style="display:flex;flex-direction:column;gap:40px;min-height:800px;padding:96px 72px;background:var(--color-surface)">
    <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:32px">
      <div style="display:flex;flex-direction:column;gap:12px;max-width:720px">
        ${eyebrow('Cardápio')}
        ${h2('Cardápio título', 'O que sai do forno hoje.')}
      </div>
      <a data-name="${LANDING_NODES.menuCta}" href="#cardapio" style="${PILL};background:var(--color-bread);color:var(--color-white)">Cardápio completo ${ICONS.arrow(18)}</a>
    </div>
    <div data-name="Produtos" style="display:grid;grid-template-columns:repeat(4,1fr);gap:24px">${items}</div>
  </section>`
}

function closing(): string {
  const quotes = [
    ['Marina', 'O country loaf virou o pão de domingo aqui em casa. Casca que canta.'],
    ['Rafael', 'Fila às 7h e vale cada minuto. A focaccia some em minutos.'],
    ['Cecília', 'Finalmente um integral que não parece tijolo. Leve, ácido na medida.'],
  ]
    .map(
      ([who, text]) => `
      <blockquote data-name="Depoimento ${who}" style="margin:0;display:flex;flex-direction:column;gap:16px;flex:1;padding:32px;border:1.5px solid var(--color-line);border-radius:var(--radius-md)">
        <p style="margin:0;${DISPLAY};font-size:24px;line-height:1.3;color:var(--color-ink)">“${text}”</p>
        <span style="${BODY};font-size:14px;font-weight:600;color:var(--color-muted)">${who}</span>
      </blockquote>`,
    )
    .join('')
  return `
  <section data-name="Fechamento" style="display:flex;flex-direction:column;gap:56px;min-height:700px;padding:96px 72px">
    <div data-name="Depoimentos" style="display:flex;gap:24px">${quotes}</div>
    <div data-name="Chamada final" style="display:flex;align-items:center;justify-content:space-between;gap:48px;padding:56px 64px;border-radius:var(--radius-lg);background:var(--color-crust-soft)">
      ${h2('Chamada título', 'Encomende a fornada de amanhã.')}
      <a data-name="CTA encomenda" href="#contato" style="${PILL};background:var(--color-bread);color:var(--color-white);flex-shrink:0">Encomendar ${ICONS.arrow(18)}</a>
    </div>
  </section>`
}

// Flow root: a column that grows with its sections — no fixed height, no
// overflow:hidden, no absolute positioning at the root.
export const LANDING_HTML = `
<div data-name="Page" style="display:flex;flex-direction:column;width:100%;background:var(--color-bg);color:var(--color-ink)">
  ${desktopHeader()}
  ${hero()}
  ${highlights()}
  ${marquee()}
  ${process()}
  ${menuTeaser()}
  ${closing()}
  ${desktopFooter()}
</div>`

// A 4K poster: one screen, fixed, enough content to be a real capture.
export const POSTER_4K_HTML = `
<div data-name="Page" style="display:flex;flex-direction:column;width:100%;height:100%;overflow:hidden;background:var(--color-bread);color:var(--color-white)">
  <div data-name="Poster" style="display:flex;flex:1;align-items:center;justify-content:space-between;gap:160px;padding:240px 320px">
    <div style="display:flex;flex-direction:column;gap:64px;max-width:1600px">
      <span style="${BODY};font-size:40px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:var(--color-crust-soft)">Breads do Breno</span>
      <h1 data-name="Poster título" style="margin:0;${DISPLAY};font-size:220px;line-height:0.98;font-weight:600;letter-spacing:-0.03em">Fornada às 7h.</h1>
      <p style="margin:0;${BODY};font-size:56px;line-height:1.4;color:var(--color-crust-soft)">Fermentação natural, forno a lenha, farinha de pedra.</p>
    </div>
    <div data-name="Poster visual" style="display:flex;align-items:center;justify-content:center;flex-shrink:0;width:1200px;height:1000px;border-radius:120px;background:var(--color-crust)">${loafIllustration(1000)}</div>
  </div>
</div>`
