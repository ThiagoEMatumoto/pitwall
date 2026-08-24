import { type Page } from 'playwright'

export type Area = 'projects' | 'features' | 'cc-configs' | 'metrics' | 'diagrams'

// Labels reais do IconRail (atributo title de cada botão) — ver src/app/IconRail.tsx.
const AREA_TITLE: Record<Area, string> = {
  projects: 'Projetos',
  features: 'Features',
  'cc-configs': 'Configs do CC',
  metrics: 'Métricas',
  diagrams: 'Diagramas',
}

// Pronto quando o IconRail está montado (botão "Projetos" visível).
export async function waitReady(page: Page): Promise<void> {
  await page.getByTitle('Projetos', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
}

export async function goToArea(page: Page, area: Area): Promise<void> {
  await page.getByTitle(AREA_TITLE[area], { exact: true }).click()
}

export async function openSettings(page: Page): Promise<void> {
  await page.getByTitle('Configurações', { exact: true }).click()
}

// Expande o projeto pelo nome na sidebar (clique no botão da linha → toggle repos).
export async function toggleProject(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: false }).first().click()
}
