import { type Page } from 'playwright'

export type Area = 'projects' | 'features' | 'cc-configs' | 'metrics' | 'diagrams' | 'meetings' | 'tasks' | 'design'

// Labels reais do IconRail (atributo title de cada botão) — ver src/app/IconRail.tsx.
const AREA_TITLE: Record<Area, string> = {
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
