// "Breads do Breno" — real pt-BR content for the Design Studio E2E. Every
// artboard uses the document tokens (var(--color-*), var(--font-*), var(--radius-md))
// so token changes propagate; nothing here is app chrome.

export const BREADS_TOKENS = {
  color: {
    primary: '#7a3e12',
    accent: '#e0a458',
    bg: '#fbf6ef',
    text: '#2b1d14',
  },
  font: {
    display: "'Fraunces', Georgia, serif",
    body: "'Manrope', system-ui, sans-serif",
  },
  radius: { md: '12px' },
}

export const BREADS_FONTS = [
  'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&display=swap',
  'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600&display=swap',
]

export const CARD_NAMES = ['Card destaque 1', 'Card destaque 2', 'Card destaque 3'] as const

const BODY = 'font-family:var(--font-body);color:var(--color-text)'
const DISPLAY = 'font-family:var(--font-display);color:var(--color-text)'
const BTN =
  'display:inline-flex;align-items:center;justify-content:center;padding:14px 26px;border-radius:999px;background-color:var(--color-primary);color:#fff;font-family:var(--font-body);font-size:15px;font-weight:600;text-decoration:none'

function header(padding: string): string {
  return `<header data-name="Header" style="display:flex;align-items:center;justify-content:space-between;padding:${padding};border-bottom:1px solid rgba(43,29,20,0.12)">
  <span data-name="Logo" style="${DISPLAY};font-size:22px;font-weight:700">Breads do Breno</span>
  <nav data-name="Nav" style="display:flex;gap:28px;${BODY};font-size:15px">
    <a href="#" style="color:var(--color-text);text-decoration:none">Início</a>
    <a data-name="Nav Cardápio" href="#" style="color:var(--color-text);text-decoration:none">Cardápio</a>
    <a href="#" style="color:var(--color-text);text-decoration:none">Contato</a>
  </nav>
</header>`
}

function card(name: string, title: string, text: string, image = 110): string {
  return `<article data-name="${name}" style="display:flex;flex-direction:column;gap:10px;padding:20px;border-radius:var(--radius-md);background-color:#fff;box-shadow:0 8px 24px rgba(43,29,20,0.08)">
  <div style="height:${image}px;border-radius:var(--radius-md);background:linear-gradient(135deg,var(--color-accent),var(--color-primary))"></div>
  <h3 style="margin:0;${DISPLAY};font-size:20px;font-weight:600">${title}</h3>
  <p style="margin:0;${BODY};font-size:14px;line-height:1.5;opacity:0.85">${text}</p>
</article>`
}

function footer(): string {
  return `<footer data-name="Footer" style="display:flex;justify-content:space-between;padding:28px 72px;background-color:var(--color-text);color:#fbf6ef;${BODY.replace('color:var(--color-text)', '')};font-size:13px">
  <span>© 2026 Breads do Breno · Padaria artesanal</span>
  <span>Rua [endereço], Curitiba · seg–sáb 7h às 19h</span>
</footer>`
}

// No wrapper element on purpose: the sections are direct children of the
// artboard root, so a plain click on the canvas selects a section (the root
// itself is styled through design_styles_update, see ROOT_STYLE). Header +
// hero + destaques fit in the 900px viewport; "Sobre" and the footer sit
// below the fold.
export const ROOT_STYLE = {
  'background-color': 'var(--color-bg)',
  'font-family': 'var(--font-body)',
  color: 'var(--color-text)',
}

export const HOME_HTML = `
${header('20px 72px')}
<section data-name="Hero" style="display:flex;align-items:center;justify-content:space-between;gap:56px;padding:40px 72px">
  <div data-name="Hero copy" style="display:flex;flex-direction:column;gap:18px;max-width:620px">
    <h1 style="margin:0;${DISPLAY};font-size:60px;line-height:1;font-weight:700;letter-spacing:-0.02em">Pão de verdade, todo dia às 7h</h1>
    <p style="margin:0;${BODY};font-size:18px;line-height:1.5;opacity:0.85">Fermentação natural de 36 horas, farinha moída na pedra e forno a lenha. Fornadas pequenas, sabor grande.</p>
    <a data-name="CTA" href="#" style="align-self:flex-start;${BTN}">Ver cardápio</a>
  </div>
  <div data-name="Hero visual" style="width:320px;height:320px;border-radius:var(--radius-md);background:radial-gradient(circle at 30% 30%,var(--color-accent),var(--color-primary) 70%)"></div>
</section>
<h2 data-name="Título destaques" style="margin:0;padding:0 72px 14px;${DISPLAY};font-size:30px;font-weight:600">Destaques da semana</h2>
<section data-name="Destaques" style="display:flex;gap:32px;padding:0 72px 40px">
  ${card(CARD_NAMES[0], 'Pão de fermentação natural', 'Casca crocante, miolo aberto e 36 horas de fermentação lenta.')}
  ${card(CARD_NAMES[1], 'Croissant de manteiga', 'Folhado em 27 camadas com manteiga francesa. Sai do forno às 8h.')}
  ${card(CARD_NAMES[2], 'Focaccia de alecrim', 'Azeite extra virgem, sal grosso e alecrim da horta.')}
</section>
<section data-name="Sobre" style="display:flex;gap:48px;padding:40px 72px;align-items:center">
  <div style="flex:1">
    <h2 style="margin:0 0 12px;${DISPLAY};font-size:30px;font-weight:600">Sobre o Breno</h2>
    <p style="margin:0;${BODY};font-size:16px;line-height:1.6;opacity:0.85">Depois de dez anos como engenheiro, o Breno trocou planilhas por farinha. A padaria nasceu em 2021 numa garagem em Curitiba e hoje entrega em toda a cidade.</p>
  </div>
</section>
${footer()}`

export const HOME_MOBILE_HTML = `
  ${header('16px 20px')}
  <section data-name="Hero" style="display:flex;flex-direction:column;gap:16px;padding:32px 20px">
    <h1 style="margin:0;${DISPLAY};font-size:40px;line-height:1.05;font-weight:700">Pão de verdade, todo dia às 7h</h1>
    <p style="margin:0;${BODY};font-size:16px;line-height:1.5;opacity:0.85">Fermentação natural de 36 horas e forno a lenha.</p>
    <a data-name="CTA" href="#" style="align-self:flex-start;${BTN}">Ver cardápio</a>
  </section>
  <section data-name="Destaques" style="display:flex;flex-direction:column;gap:16px;padding:0 20px 32px">
    ${card(CARD_NAMES[0], 'Pão de fermentação natural', 'Casca crocante e miolo aberto.', 90)}
    ${card(CARD_NAMES[1], 'Croissant de manteiga', 'Folhado em 27 camadas.', 90)}
  </section>
  ${footer().replace('padding:28px 72px', 'padding:20px;flex-direction:column;gap:8px')}`

const MENU_ITEMS: Array<[string, string, string]> = [
  ['Pão de fermentação natural', '900 g · trigo e centeio', 'R$ 32'],
  ['Croissant de manteiga', 'unidade', 'R$ 14'],
  ['Focaccia de alecrim', 'fatia', 'R$ 12'],
  ['Pão de queijo de forno', '6 unidades', 'R$ 18'],
  ['Baguete rústica', '350 g', 'R$ 16'],
  ['Cinnamon roll', 'unidade', 'R$ 15'],
]

export const MENU_HTML = `
  ${header('24px 72px')}
  <h1 style="margin:0;padding:56px 72px 24px;${DISPLAY};font-size:56px;font-weight:700">Cardápio</h1>
  <section data-name="Itens" style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:0 72px 56px">
    ${MENU_ITEMS.map(
      ([
        title,
        meta,
        price,
      ]) => `<article data-name="${title}" style="display:flex;flex-direction:column;gap:8px;padding:20px;border-radius:var(--radius-md);background-color:#fff;box-shadow:0 8px 24px rgba(43,29,20,0.08)">
      <div style="height:120px;border-radius:var(--radius-md);background:linear-gradient(135deg,var(--color-accent),var(--color-primary))"></div>
      <h3 style="margin:0;${DISPLAY};font-size:20px;font-weight:600">${title}</h3>
      <span style="${BODY};font-size:13px;opacity:0.7">${meta}</span>
      <strong style="${BODY};font-size:18px;color:var(--color-primary)">${price}</strong>
    </article>`,
    ).join('\n')}
  </section>
  ${footer()}`

export const CONTACT_HTML = `
  ${header('24px 72px')}
  <section data-name="Contato" style="display:flex;gap:64px;padding:56px 72px">
    <div data-name="Informações" style="display:flex;flex-direction:column;gap:16px;flex:1">
      <h1 style="margin:0;${DISPLAY};font-size:56px;font-weight:700">Fale com a gente</h1>
      <p style="margin:0;${BODY};font-size:17px;line-height:1.6">Rua [endereço], nº [número] · Curitiba, PR</p>
      <p style="margin:0;${BODY};font-size:17px;line-height:1.6">Segunda a sábado, das 7h às 19h. Domingo das 7h às 13h.</p>
      <p style="margin:0;${BODY};font-size:17px;line-height:1.6">WhatsApp (41) 9 [número] · ola@breadsdobreno.com.br</p>
    </div>
    <form data-name="Formulário" style="display:flex;flex-direction:column;gap:12px;flex:1;padding:28px;border-radius:var(--radius-md);background-color:#fff;box-shadow:0 8px 24px rgba(43,29,20,0.08)">
      <label style="${BODY};font-size:13px;font-weight:600">Nome</label>
      <input type="text" placeholder="Seu nome" style="padding:12px;border:1px solid rgba(43,29,20,0.2);border-radius:8px;${BODY};font-size:15px">
      <label style="${BODY};font-size:13px;font-weight:600">E-mail</label>
      <input type="email" placeholder="voce@exemplo.com" style="padding:12px;border:1px solid rgba(43,29,20,0.2);border-radius:8px;${BODY};font-size:15px">
      <label style="${BODY};font-size:13px;font-weight:600">Mensagem</label>
      <textarea placeholder="Encomendas, dúvidas, elogios…" style="min-height:120px;padding:12px;border:1px solid rgba(43,29,20,0.2);border-radius:8px;${BODY};font-size:15px"></textarea>
      <button type="button" style="${BTN};border:0;cursor:pointer">Enviar mensagem</button>
    </form>
  </section>
  ${footer()}`
