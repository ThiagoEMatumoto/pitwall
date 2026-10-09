import { type Locator, type Page } from 'playwright'

export type Area = 'overview' | 'projects' | 'features' | 'cc-configs' | 'metrics' | 'diagrams' | 'meetings' | 'tasks' | 'design'

// Labels reais do IconRail (atributo title de cada botão) — ver src/app/IconRail.tsx.
const AREA_TITLE: Record<Area, string> = {
  overview: 'Home',
  projects: 'Projetos',
  features: 'Features',
  'cc-configs': 'Configs do CC',
  metrics: 'Métricas',
  diagrams: 'Diagramas',
  meetings: 'Reuniões',
  tasks: 'Tarefas',
  design: 'Design',
}

// Pronto quando o IconRail está montado (botão "Projetos" visível).
// Prefix-match: o title dos botões de área ganha sufixo dinâmico quando há
// badge (ex.: "Projetos · 1 aguardando você") — exact match quebrava.
function areaButton(page: Page, title: string) {
  return page.getByTitle(new RegExp(`^${title}($| ·)`)).first()
}

export async function waitReady(page: Page): Promise<void> {
  await areaButton(page, 'Projetos').waitFor({ state: 'visible', timeout: 30_000 })
}

export async function goToArea(page: Page, area: Area): Promise<void> {
  await areaButton(page, AREA_TITLE[area]).click()
}

export async function openSettings(page: Page): Promise<void> {
  await page.getByTitle('Configurações', { exact: true }).click()
}

// Expande o projeto pelo nome na sidebar (clique no botão da linha → toggle repos).
export async function toggleProject(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: false }).first().click()
}

// Clica no card do mapa onde ele está VISÍVEL. Com o painel da mãe e o da Room
// abertos, o mapa fica estreito e a lane da feature passa da borda: o centro do
// cabeçalho cai fora do mapa (sobre o painel da mãe), que é onde o click padrão
// do Playwright mira. Espera o enquadramento assentar e mira o meio do trecho
// do cabeçalho que está dentro do mapa — onde a pessoa clicaria.
export async function clickVisibleInMap(page: Page, target: Locator): Promise<void> {
  const map = page.getByTestId('session-map')
  let prev = ''
  for (let i = 0; i < 20; i++) {
    const now = JSON.stringify(await target.boundingBox())
    if (now === prev && now !== 'null') break
    prev = now
    await page.waitForTimeout(150)
  }
  const box = await target.boundingBox()
  const area = await map.boundingBox()
  if (!box || !area) return target.click()
  const left = Math.max(box.x, area.x)
  const right = Math.min(box.x + box.width, area.x + area.width)
  const top = Math.max(box.y, area.y)
  const bottom = Math.min(box.y + box.height, area.y + area.height)
  if (right <= left || bottom <= top) return target.click()
  await target.click({
    position: { x: (left + right) / 2 - box.x, y: (top + bottom) / 2 - box.y },
  })
}
