// Cardápio and Contato artboards (1440×900) for Breads do Breno.
import { ICONS } from './brand'
import { desktopFooter, desktopHeader } from './content-home'

const BODY = 'font-family:var(--font-body)'
const DISPLAY = 'font-family:var(--font-display)'

interface MenuItem {
  name: string
  note: string
  price: string
}

function menuSection(name: string, iconSvg: string, title: string, items: MenuItem[]): string {
  const rows = items
    .map(
      (it) => `
    <li data-name="Item" style="display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:14px 0;border-top:1px solid var(--color-line)">
      <div style="display:flex;flex-direction:column;gap:3px;min-width:0">
        <span style="${DISPLAY};font-size:19px;font-weight:600;color:var(--color-ink)">${it.name}</span>
        <span style="${BODY};font-size:13px;line-height:1.4;color:var(--color-muted)">${it.note}</span>
      </div>
      <span style="flex-shrink:0;${BODY};font-size:16px;font-weight:700;color:var(--color-bread)">${it.price}</span>
    </li>`,
    )
    .join('')
  return `
<article data-name="${name}" style="display:flex;flex-direction:column;flex:1;padding:28px 28px 16px;background:var(--color-white);border-radius:var(--radius-md);box-shadow:var(--shadow-card)">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
    <span style="display:flex;width:36px;height:36px;align-items:center;justify-content:center;border-radius:10px;background:var(--color-surface);color:var(--color-crust)">${iconSvg}</span>
    <h2 data-name="${name} título" style="margin:0;${DISPLAY};font-size:24px;font-weight:600;color:var(--color-ink)">${title}</h2>
  </div>
  <ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column">${rows}
  </ul>
</article>`
}

export const MENU_HTML = `
<div data-name="Page" style="display:flex;flex-direction:column;width:100%;height:100%;overflow:hidden;background:var(--color-bg);color:var(--color-ink)">
  ${desktopHeader()}
  <section data-name="Intro" style="display:flex;align-items:flex-end;justify-content:space-between;gap:40px;padding:44px 72px 28px">
    <div style="display:flex;flex-direction:column;gap:12px">
      <span style="${BODY};font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--color-olive)">Cardápio</span>
      <h1 data-name="Título" style="margin:0;${DISPLAY};font-size:56px;line-height:1.05;font-weight:600;letter-spacing:-0.02em">O que sai do forno hoje</h1>
      <p style="margin:0;${BODY};font-size:17px;line-height:1.5;color:var(--color-muted);max-width:620px">Preços de exemplo. O cardápio muda com a estação e com a farinha da semana — o que está na vitrine é o que está aqui.</p>
    </div>
    <span data-name="Fornada" style="display:inline-flex;align-items:center;gap:10px;padding:12px 18px;border-radius:var(--radius-pill);background:var(--color-surface);color:var(--color-bread);${BODY};font-size:14px;font-weight:600">${ICONS.fire(18)} Fornadas às 7h e às 15h · até acabar</span>
  </section>
  <section data-name="Menu grid" style="display:flex;gap:20px;padding:0 72px 32px">
    ${menuSection('Seção pães', ICONS.wheat(20), 'Pães de fermentação natural', [
      {
        name: 'Pão de campanha',
        note: 'Trigo branco e integral, 36h de fermentação · 900g',
        price: 'R$ 32',
      },
      {
        name: 'Integral com sementes',
        note: 'Girassol, linhaça e gergelim · 800g',
        price: 'R$ 34',
      },
      {
        name: 'Ciabatta',
        note: 'Miolo aberto, azeite e sal grosso · unidade',
        price: 'R$ 12',
      },
      {
        name: 'Baguete rústica',
        note: 'Casca fina e crocante · unidade',
        price: 'R$ 14',
      },
    ])}
    ${menuSection('Seção viennoiserie', ICONS.fire(20), 'Manteiga e folhas', [
      {
        name: 'Croissant',
        note: 'Manteiga francesa, 27 dobras · unidade',
        price: 'R$ 14',
      },
      {
        name: 'Pain au chocolat',
        note: 'Chocolate 70% · unidade',
        price: 'R$ 16',
      },
      {
        name: 'Cinnamon roll',
        note: 'Canela do Ceilão e cream cheese · unidade',
        price: 'R$ 15',
      },
      {
        name: 'Folhado de goiabada',
        note: 'Goiabada cascão e queijo minas · unidade',
        price: 'R$ 13',
      },
    ])}
    ${menuSection('Seção vitrine', ICONS.clock(20), 'Da vitrine e do balcão', [
      {
        name: 'Focaccia de alecrim',
        note: 'Azeite, flor de sal e alecrim fresco · fatia',
        price: 'R$ 18',
      },
      {
        name: 'Sanduíche de presunto cru',
        note: 'No pão de campanha, com manteiga e rúcula',
        price: 'R$ 28',
      },
      {
        name: 'Café coado',
        note: 'Grãos da Mantiqueira, torra média · 200ml',
        price: 'R$ 8',
      },
      {
        name: 'Suco de laranja',
        note: 'Espremido na hora · 300ml',
        price: 'R$ 12',
      },
    ])}
  </section>
  <section data-name="Encomendas" style="display:flex;align-items:center;justify-content:space-between;gap:24px;margin:0 72px 32px;padding:20px 28px;border-radius:var(--radius-md);background:var(--color-olive);color:var(--color-white)">
    <div style="display:flex;flex-direction:column;gap:4px">
      <strong style="${DISPLAY};font-size:22px;font-weight:600">Encomendas para festas e restaurantes</strong>
      <span style="${BODY};font-size:15px;opacity:0.9">Pedidos acima de 10 unidades com 24h de antecedência. Entregamos na região.</span>
    </div>
    <a data-name="CTA encomenda" href="#contato" style="display:inline-flex;align-items:center;gap:10px;flex-shrink:0;padding:14px 24px;border-radius:var(--radius-pill);background:var(--color-white);color:var(--color-olive);text-decoration:none;${BODY};font-size:15px;font-weight:700">Fazer encomenda ${ICONS.arrow(16)}</a>
  </section>
  ${desktopFooter()}
</div>`

function hoursRow(day: string, hours: string, closed = false): string {
  return `
<li style="display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid var(--color-line);${BODY};font-size:16px">
  <span style="color:var(--color-ink);font-weight:500">${day}</span>
  <span style="color:${closed ? 'var(--color-muted)' : 'var(--color-bread)'};font-weight:${closed ? 500 : 600}">${hours}</span>
</li>`
}

function field(name: string, label: string, grow = false): string {
  return `
<label data-name="${name}" style="display:flex;flex-direction:column;gap:8px;${grow ? 'flex:1;' : ''}${BODY};font-size:13px;font-weight:600;color:var(--color-muted);letter-spacing:0.02em">${label}
  <input data-name="${name} input" style="height:${grow ? '96px' : '48px'};padding:0 14px;border:1.5px solid var(--color-line);border-radius:var(--radius-sm);background:var(--color-bg);color:var(--color-ink);${BODY};font-size:15px;outline:none">
</label>`
}

export const CONTACT_HTML = `
<div data-name="Page" style="display:flex;flex-direction:column;width:100%;height:100%;overflow:hidden;background:var(--color-bg);color:var(--color-ink)">
  ${desktopHeader()}
  <section data-name="Contato" style="display:flex;gap:64px;padding:52px 72px 40px">
    <div data-name="Info" style="display:flex;flex-direction:column;gap:28px;flex:1;max-width:600px">
      <div style="display:flex;flex-direction:column;gap:12px">
        <span style="${BODY};font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--color-olive)">Contato</span>
        <h1 data-name="Título" style="margin:0;${DISPLAY};font-size:56px;line-height:1.05;font-weight:600;letter-spacing:-0.02em">Venha sentir o cheiro do pão.</h1>
        <p style="margin:0;${BODY};font-size:17px;line-height:1.5;color:var(--color-muted)">A padaria fica a duas quadras da praça. Chegue cedo: o pão de campanha costuma acabar antes das 11h.</p>
      </div>
      <div data-name="Endereço" style="display:flex;align-items:flex-start;gap:14px;padding:18px 20px;border-radius:var(--radius-md);background:var(--color-surface)">
        <span style="display:flex;flex-shrink:0;color:var(--color-crust)">${ICONS.pin(22)}</span>
        <div style="display:flex;flex-direction:column;gap:4px;${BODY}">
          <strong style="font-size:16px;color:var(--color-ink)">[ENDEREÇO]</strong>
          <span style="font-size:14px;color:var(--color-muted)">Estacionamento na rua · Entrada acessível</span>
        </div>
      </div>
      <div data-name="Horários" style="display:flex;flex-direction:column">
        <span style="display:flex;align-items:center;gap:10px;margin-bottom:6px;${DISPLAY};font-size:22px;font-weight:600"><span style="display:flex;color:var(--color-crust)">${ICONS.clock(20)}</span> Horários</span>
        <ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column">
          ${hoursRow('Terça a sexta', '7h – 19h')}
          ${hoursRow('Sábado', '7h – 15h')}
          ${hoursRow('Domingo', '7h – 13h')}
          ${hoursRow('Segunda', 'Fechado (dia do forno descansar)', true)}
        </ul>
      </div>
      <div data-name="Canais" style="display:flex;gap:28px;${BODY};font-size:15px;color:var(--color-ink)">
        <span style="display:flex;align-items:center;gap:8px"><span style="display:flex;color:var(--color-crust)">${ICONS.phone(18)}</span> WhatsApp [TELEFONE]</span>
        <span style="display:flex;align-items:center;gap:8px"><span style="display:flex;color:var(--color-crust)">${ICONS.instagram(18)}</span> @breadsdobreno</span>
      </div>
    </div>
    <form data-name="Formulário de encomenda" style="display:flex;flex-direction:column;gap:18px;width:520px;padding:32px;border-radius:var(--radius-lg);background:var(--color-white);box-shadow:var(--shadow-card)">
      <div style="display:flex;flex-direction:column;gap:6px">
        <h2 style="margin:0;${DISPLAY};font-size:28px;font-weight:600">Faça sua encomenda</h2>
        <p style="margin:0;${BODY};font-size:14px;line-height:1.5;color:var(--color-muted)">Respondemos no mesmo dia. Pedidos com 24h de antecedência.</p>
      </div>
      ${field('Campo nome', 'Seu nome')}
      <div style="display:flex;gap:14px">
        ${field('Campo telefone', 'WhatsApp', true)}
        ${field('Campo data', 'Data de retirada', true)}
      </div>
      ${field('Campo pedido', 'O que você quer encomendar?')}
      <button data-name="Enviar" style="display:inline-flex;align-items:center;justify-content:center;gap:10px;height:52px;border:0;border-radius:var(--radius-pill);background:var(--color-bread);color:var(--color-white);${BODY};font-size:16px;font-weight:700">Enviar pedido ${ICONS.arrow(18)}</button>
    </form>
  </section>
  ${desktopFooter()}
</div>`
