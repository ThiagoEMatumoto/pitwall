// Home artboards (desktop 1440×900 and mobile 390×844) for Breads do Breno.
import { ICONS, LOGO_MARK, loafIllustration } from './brand'

const BODY = 'font-family:var(--font-body)'
const DISPLAY = 'font-family:var(--font-display)'
const NAV_LINK = `color:var(--color-ink);text-decoration:none;${BODY};font-size:15px;font-weight:500`

export function desktopHeader(): string {
  return `
<header data-name="Header" style="display:flex;align-items:center;justify-content:space-between;height:84px;padding:0 72px;border-bottom:1px solid var(--color-line);flex-shrink:0">
  <a data-name="Logo" href="#home" style="display:flex;align-items:center;gap:12px;text-decoration:none;color:var(--color-ink)">
    ${LOGO_MARK}
    <span style="${DISPLAY};font-size:22px;font-weight:600;letter-spacing:-0.01em">Breads do Breno</span>
  </a>
  <nav data-name="Nav" style="display:flex;align-items:center;gap:36px">
    <a data-name="Nav Cardápio" href="#cardapio" style="${NAV_LINK}">Cardápio</a>
    <a data-name="Nav Sobre" href="#sobre" style="${NAV_LINK}">Sobre</a>
    <a data-name="Nav Contato" href="#contato" style="${NAV_LINK}">Contato</a>
    <a data-name="Nav CTA" href="#contato" style="display:inline-flex;align-items:center;gap:8px;padding:11px 20px;border-radius:var(--radius-pill);background:var(--color-bread);color:var(--color-white);text-decoration:none;${BODY};font-size:14px;font-weight:600">Encomendar ${ICONS.arrow(16)}</a>
  </nav>
</header>`
}

export function desktopFooter(): string {
  return `
<footer data-name="Footer" style="display:flex;align-items:center;justify-content:space-between;padding:0 72px;height:96px;background:var(--color-bread);color:var(--color-white);flex-shrink:0;margin-top:auto">
  <div style="display:flex;align-items:center;gap:12px;${BODY};font-size:15px">
    <span style="display:flex;color:var(--color-crust-soft)">${ICONS.clock(20)}</span>
    <span>Terça a domingo, das 7h às 19h · Fornada às 7h e às 15h</span>
  </div>
  <div style="display:flex;align-items:center;gap:12px;${BODY};font-size:15px">
    <span style="display:flex;color:var(--color-crust-soft)">${ICONS.pin(20)}</span>
    <span>[ENDEREÇO]</span>
  </div>
  <div style="display:flex;align-items:center;gap:10px;${BODY};font-size:15px">
    <span style="display:flex;color:var(--color-crust-soft)">${ICONS.instagram(20)}</span>
    <span>@breadsdobreno</span>
  </div>
</footer>`
}

function highlight(name: string, iconSvg: string, title: string, text: string): string {
  return `
<article data-name="${name}" style="display:flex;flex-direction:column;gap:12px;flex:1;padding:24px 28px;background:var(--color-surface);border-radius:var(--radius-md)">
  <span style="display:flex;width:40px;height:40px;align-items:center;justify-content:center;border-radius:var(--radius-sm);background:var(--color-white);color:var(--color-crust)">${iconSvg}</span>
  <h3 style="margin:0;${DISPLAY};font-size:22px;font-weight:600;color:var(--color-ink)">${title}</h3>
  <p style="margin:0;${BODY};font-size:15px;line-height:1.5;color:var(--color-muted)">${text}</p>
</article>`
}

export const HOME_DESKTOP_HTML = `
<div data-name="Page" style="display:flex;flex-direction:column;width:100%;height:100%;overflow:hidden;background:var(--color-bg);color:var(--color-ink)">
  ${desktopHeader()}
  <section data-name="Hero" style="display:flex;align-items:center;justify-content:space-between;gap:64px;padding:48px 72px 40px">
    <div data-name="Hero copy" style="display:flex;flex-direction:column;gap:24px;max-width:640px">
      <span data-name="Eyebrow" style="display:inline-flex;align-items:center;gap:10px;${BODY};font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--color-olive)">${ICONS.wheat(18)} Padaria artesanal · Fermentação natural</span>
      <h1 data-name="Headline" style="margin:0;${DISPLAY};font-size:72px;line-height:1.02;font-weight:600;letter-spacing:-0.02em;color:var(--color-ink)">Pão de verdade, saído do forno todo dia às 7h.</h1>
      <p data-name="Lead" style="margin:0;${BODY};font-size:19px;line-height:1.55;color:var(--color-muted);max-width:540px">Fermentação natural de 36 horas, farinha moída na pedra e forno a lenha. Sem melhoradores, sem pressa — só farinha, água, sal e tempo.</p>
      <div data-name="Actions" style="display:flex;align-items:center;gap:16px;margin-top:8px">
        <a data-name="CTA" href="#cardapio" style="display:inline-flex;align-items:center;gap:10px;padding:16px 28px;border-radius:var(--radius-pill);background:var(--color-crust);color:var(--color-ink);text-decoration:none;${BODY};font-size:16px;font-weight:700">Ver o cardápio de hoje ${ICONS.arrow(18)}</a>
        <a data-name="CTA secundário" href="#contato" style="display:inline-flex;align-items:center;padding:16px 24px;border-radius:var(--radius-pill);border:1.5px solid var(--color-bread);color:var(--color-bread);text-decoration:none;${BODY};font-size:16px;font-weight:600">Como chegar</a>
      </div>
    </div>
    <div data-name="Hero visual" style="position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;width:520px;height:440px;border-radius:var(--radius-lg);background:radial-gradient(circle at 30% 20%, var(--color-crust-soft), var(--color-crust) 55%, #9A5F1E 100%);box-shadow:var(--shadow-card)">
      ${loafIllustration(400)}
      <span data-name="Visual chip" style="display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border-radius:var(--radius-pill);background:var(--color-white);color:var(--color-bread);${BODY};font-size:13px;font-weight:600">${ICONS.fire(16)} Pão de campanha · 36h de fermentação</span>
    </div>
  </section>
  <section data-name="Highlights" style="display:flex;gap:20px;padding:0 72px 40px">
    ${highlight('Destaque fermentação', ICONS.wheat(22), 'Fermentação de 36h', 'Levain próprio desde 2019. Miolo aberto, casca crocante e digestão leve.')}
    ${highlight('Destaque farinha', ICONS.stone(22), 'Farinha moída na pedra', 'Trigo de pequenos produtores do sul de Minas, moído semanalmente.')}
    ${highlight('Destaque forno', ICONS.fire(22), 'Forno a lenha', 'Duas fornadas por dia. O pão da tarde sai quentinho às 15h.')}
  </section>
  ${desktopFooter()}
</div>`

function mobileRow(iconSvg: string, title: string, text: string): string {
  return `
<div style="display:flex;align-items:flex-start;gap:14px;padding:14px 16px;background:var(--color-surface);border-radius:var(--radius-sm)">
  <span style="display:flex;flex-shrink:0;width:36px;height:36px;align-items:center;justify-content:center;border-radius:10px;background:var(--color-white);color:var(--color-crust)">${iconSvg}</span>
  <div style="display:flex;flex-direction:column;gap:2px">
    <strong style="${DISPLAY};font-size:17px;font-weight:600;color:var(--color-ink)">${title}</strong>
    <span style="${BODY};font-size:13px;line-height:1.45;color:var(--color-muted)">${text}</span>
  </div>
</div>`
}

export const HOME_MOBILE_HTML = `
<div data-name="Page" style="display:flex;flex-direction:column;width:100%;height:100%;overflow:hidden;background:var(--color-bg);color:var(--color-ink)">
  <header data-name="Header" style="display:flex;align-items:center;justify-content:space-between;height:64px;padding:0 20px;border-bottom:1px solid var(--color-line);flex-shrink:0">
    <a data-name="Logo" href="#home" style="display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--color-ink)">
      ${LOGO_MARK.replace('width="36" height="36"', 'width="30" height="30"')}
      <span style="${DISPLAY};font-size:18px;font-weight:600">Breads do Breno</span>
    </a>
    <button data-name="Menu" style="display:flex;align-items:center;justify-content:center;width:40px;height:40px;border:0;border-radius:var(--radius-sm);background:var(--color-surface);color:var(--color-ink)">${ICONS.menu(22)}</button>
  </header>
  <section data-name="Hero" style="display:flex;flex-direction:column;gap:16px;padding:28px 20px 20px">
    <span data-name="Eyebrow" style="display:inline-flex;align-items:center;gap:8px;${BODY};font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--color-olive)">${ICONS.wheat(16)} Fermentação natural</span>
    <h1 data-name="Headline" style="margin:0;${DISPLAY};font-size:40px;line-height:1.05;font-weight:600;letter-spacing:-0.02em">Pão de verdade, todo dia às 7h.</h1>
    <p data-name="Lead" style="margin:0;${BODY};font-size:16px;line-height:1.5;color:var(--color-muted)">36 horas de fermentação, farinha moída na pedra e forno a lenha. Só farinha, água, sal e tempo.</p>
    <a data-name="CTA" href="#cardapio" style="display:flex;align-items:center;justify-content:center;gap:10px;padding:16px 20px;border-radius:var(--radius-pill);background:var(--color-crust);color:var(--color-ink);text-decoration:none;${BODY};font-size:16px;font-weight:700">Ver o cardápio de hoje ${ICONS.arrow(18)}</a>
  </section>
  <div data-name="Hero visual" style="display:flex;align-items:center;justify-content:center;margin:0 20px;height:170px;border-radius:var(--radius-md);background:radial-gradient(circle at 30% 20%, var(--color-crust-soft), var(--color-crust) 60%, #9A5F1E 100%);overflow:hidden">
    ${loafIllustration(230)}
  </div>
  <section data-name="Highlights" style="display:flex;flex-direction:column;gap:10px;padding:20px">
    ${mobileRow(ICONS.wheat(20), 'Fermentação de 36h', 'Levain próprio, miolo aberto e casca crocante.')}
    ${mobileRow(ICONS.stone(20), 'Farinha moída na pedra', 'Trigo de pequenos produtores do sul de Minas.')}
    ${mobileRow(ICONS.fire(20), 'Forno a lenha', 'Fornadas às 7h e às 15h, todos os dias.')}
  </section>
  <footer data-name="Footer" style="display:flex;flex-direction:column;gap:6px;margin-top:auto;padding:18px 20px;background:var(--color-bread);color:var(--color-white);${BODY};font-size:13px">
    <span style="display:flex;align-items:center;gap:8px"><span style="display:flex;color:var(--color-crust-soft)">${ICONS.clock(16)}</span> Ter–Dom · 7h às 19h</span>
    <span style="display:flex;align-items:center;gap:8px"><span style="display:flex;color:var(--color-crust-soft)">${ICONS.pin(16)}</span> [ENDEREÇO]</span>
  </footer>
</div>`
