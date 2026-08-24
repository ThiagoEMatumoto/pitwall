// Valida o lado HUMANO do editor: edição com autosave, snapshot no flush,
// rename, dialog de histórico e copiar PNG.
import { launchApp } from '../driver/launch'
import { screenshot } from '../driver/capture'
import { goToArea, waitReady } from '../driver/nav'

const log = (...a: unknown[]) => console.log('[toolbar]', ...a)

const mk = (id: string, x: number) => ({
  id, type: 'rectangle', x, y: 100, width: 160, height: 60, angle: 0,
  strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
  strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100,
  groupIds: [], frameId: null, index: 'a' + x, roundness: { type: 3 },
  seed: 7, version: 1, versionNonce: 7, isDeleted: false,
  boundElements: [], updated: 1, link: null, locked: false,
})
const scene = { elements: [mk('h1', 100), mk('h2', 400)] }

const { app, page } = await launchApp()
const errors: string[] = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)) })
try {
  await waitReady(page)
  const created = await page.evaluate(async (sc) => {
    return await (window as any).api.diagrams.create({
      title: 'Toolbar test', kind: 'flow', author: 'human', summary: 'seed', scene: sc,
    })
  }, scene)
  log('created keys:', JSON.stringify(Object.keys(created ?? {})), JSON.stringify(created?.id ?? created?.diagram?.id))
  const dgId = created?.id ?? created?.diagram?.id
  await goToArea(page, 'diagrams')
  await page.getByText('Toolbar test').first().click()
  await page.locator('.excalidraw').waitFor({ timeout: 20000 })
  await page.waitForTimeout(2000)

  // 1. edição humana: seleciona tudo e move com setas (10 nudges de 1-2px? excalidraw move step)
  await page.locator('.excalidraw').click({ position: { x: 200, y: 200 } })
  await page.keyboard.press('Control+a')
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(1600) // > debounce 800ms
  const head1 = await page.evaluate(async (id) => {
    const d = await (window as any).api.diagrams.get(id)
    const el = d.scene.elements.find((e: any) => e.id === 'h1')
    return { version: d.version, y: el?.y }
  }, dgId)
  log('autosave: y do h1 persistido =', head1.y, '(seed era 100) | head version =', head1.version)

  // 2. troca de área → flush snapshot:true → linha de histórico 'human'
  await screenshot(page, 'tb-00-before-nav')
  const titles = await page.evaluate(() => Array.from(document.querySelectorAll('nav [title], aside [title], [title]')).slice(0, 40).map((e) => e.getAttribute('title')))
  log('titles no DOM:', JSON.stringify(titles))
  await goToArea(page, 'projects')
  await page.waitForTimeout(1000)
  const vers = await page.evaluate(async (id) => (window as any).api.diagrams.listVersions(id), dgId)
  log('versions pós-flush:', JSON.stringify(vers?.map((v: any) => ({ v: v.version, a: v.author, s: v.summary }))))
  await goToArea(page, 'diagrams')
  await page.getByText('Toolbar test').first().click()
  await page.locator('.excalidraw').waitFor({ timeout: 20000 })
  await page.waitForTimeout(1500)

  // 3. rename via título da toolbar
  const titleBox = page.getByRole('main').getByRole('textbox').first()
  await titleBox.fill('Toolbar renomeado')
  await titleBox.press('Enter')
  await page.waitForTimeout(800)
  const renamed = await page.evaluate(async (id) => (await (window as any).api.diagrams.get(id)).title, dgId)
  log('rename persistido:', JSON.stringify(renamed))

  // 4. menu ⋯ → Histórico
  await page.getByRole('main').getByTitle('Mais ações', { exact: true }).click()
  await screenshot(page, 'tb-01-menu')
  const menuText = await page.locator('body').innerText()
  const hasHist = /Hist[oó]rico/.test(menuText)
  log('menu tem Histórico?', hasHist)
  if (hasHist) {
    await page.getByText(/Hist[oó]rico/).first().click()
    await page.waitForTimeout(800)
    await screenshot(page, 'tb-02-historico')
    const dlgText = await page.locator('body').innerText()
    log('dialog histórico mostra versões?', /Edi[cç][aã]o no canvas|seed/.test(dlgText))
    await page.keyboard.press('Escape')
  }

  // 5. menu ⋯ → Copiar PNG
  await page.getByRole('main').getByTitle('Mais ações', { exact: true }).click()
  const pngItem = page.getByText(/Copiar (como )?PNG/i).first()
  if (await pngItem.count()) {
    await pngItem.click()
    await page.waitForTimeout(2500)
    await screenshot(page, 'tb-03-copy-png')
    log('copiar PNG clicado (ver toast no screenshot)')
  } else {
    log('item Copiar PNG não encontrado no menu')
    await page.keyboard.press('Escape')
  }

  log('console errors:', errors.length, JSON.stringify([...new Set(errors)].slice(0, 5)))
} finally { await app.close() }
