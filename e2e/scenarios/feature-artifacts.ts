import { launchApp } from '../driver/launch'
import { captureLogs, screenshot } from '../driver/capture'
import { goToArea, waitReady } from '../driver/nav'

// Validação da seção "Artefatos" do dossiê da feature: diagramas e designs
// ligados com parentType=feature. Semeia na cópia do userData (descartada no
// fim) uma feature com 1 diagrama de fluxo + 1 design ligados, abre o dossiê,
// confere a seção e que o clique leva ao editor do diagrama.

const { app, page } = await launchApp({
  extraArgs: [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--ozone-platform=x11',
  ],
})
const { stop } = captureLogs(app, page)
try {
  await waitReady(page)

  const seeded = await page.evaluate(async () => {
    const api = (window as any).api
    const projects = await api.projects.list()
    const project = projects[0] ?? (await api.projects.create({ name: 'E2E Artefatos' }))
    const feature = await api.features.create({
      projectId: project.id,
      title: 'E2E feature com artefatos',
    })
    const links = [{ parentType: 'feature', parentId: feature.id }]
    const diagram = await api.diagrams.create({
      title: 'E2E fluxo de checkout',
      kind: 'flow',
      scene: { elements: [] },
      author: 'claude',
      links,
    })
    const doc = await api.design.documentCreate({ title: 'E2E tela de checkout', links })
    return { featureTitle: feature.title as string, diagramId: diagram.id, docId: doc.id }
  })
  console.log('[seed]', JSON.stringify(seeded))

  await page.waitForTimeout(1500)
  await screenshot(page, 'feature-artifacts-00-boot')
  await page.keyboard.press('Escape')
  await goToArea(page, 'features')
  await page.getByText(seeded.featureTitle).first().click()
  const section = page.getByTestId('feature-artifacts')
  await section.getByText('E2E fluxo de checkout').waitFor({ state: 'visible' })
  await section.getByText('E2E tela de checkout').waitFor({ state: 'visible' })
  await section.scrollIntoViewIfNeeded()
  const rows = await section.getByTestId('feature-artifact').allInnerTexts()
  console.log('[rows]', JSON.stringify(rows))
  await screenshot(page, 'feature-artifacts-01-section')

  await section.getByText('E2E fluxo de checkout').click()
  await page.waitForTimeout(1500)
  await screenshot(page, 'feature-artifacts-02-diagram-opened')
  console.log('[after-click-hash]', await page.evaluate(() => location.hash))
} finally {
  stop()
  await app.close()
}
