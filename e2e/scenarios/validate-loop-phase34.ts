/**
 * Fases 3 e 4 do loop, num unico launch (abrir o app dispara git pull em ~33 repos):
 *
 *  PASSO 2 — o app sobe, Features abre NA PAREDE (view default), pin/unpin
 *            reflete na tela, o dossie abre com pulso + liveness (+ faixa de
 *            higiene quando ha issue) e o renderer nao solta erro.
 *  PASSO 3 — a integracao: "Trabalhar nesta feature" abre o dialogo com a
 *            feature ja preenchida e o repo pre-selecionado (SEM confirmar o
 *            spawn), feature sem repo mostra a nota, e FeatureSessions lista as
 *            sessoes com a acao certa.
 *  PASSO 5 — feature_pin aparece em tools/list e funciona de verdade.
 *
 * Ao final salva uma copia do app.db (ja com o WAL checkpointado pelo close)
 * pro PASSO 4, que roda fora do Electron.
 */
import { copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp } from '../driver/launch'
import { captureLogs, screenshot } from '../driver/capture'
import { goToArea, waitReady } from '../driver/nav'
import { queryDb } from '../driver/inspect'

// Feature COM repo vinculado (legal-core) e 24 sessoes registradas.
const FEAT_A_ID = 'b7be32f6-2f79-40f0-bc44-64d48876d268'
const FEAT_A_TITLE = 'Comunicação pós-protocolização com o requerente'
const FEAT_A_REPO_LABEL = 'legal-core'
// Feature SEM nenhum repo vinculado.
const FEAT_B_TITLE = 'Video Lab — laboratório de vídeos'

const DB_OUT = process.env.CM_DB_OUT ?? '/tmp/loop34-app.db'

const log = (m: string) => console.log(`[loop34] ${m}`)
let ok = true
const check = (label: string, cond: boolean, extra = '') => {
  if (!cond) ok = false
  log(`${cond ? 'OK  ' : 'FALHA'} ${label}${extra ? ' :: ' + extra : ''}`)
}

const rendererErrors: string[] = []

const { app, page, userDataCopy } = await launchApp()
const { logFile, stop } = captureLogs(app, page)
const shots: string[] = []
const shot = async (name: string) => {
  shots.push(await screenshot(page, name))
}

page.on('pageerror', (e) => rendererErrors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') rendererErrors.push(`console.error: ${m.text()}`)
})

let rpcId = 0
async function mcp(method: string, params?: unknown): Promise<any> {
  const info = JSON.parse(readFileSync(join(userDataCopy, 'mcp.json'), 'utf8')) as {
    url: string
    token: string
  }
  const res = await fetch(info.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${info.token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params: params ?? {} }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
  if (text.startsWith('event:') || text.includes('\ndata: ')) {
    const line = text.split('\n').find((l) => l.startsWith('data: '))
    if (!line) throw new Error(`SSE sem data: ${text.slice(0, 200)}`)
    return JSON.parse(line.slice(6))
  }
  return JSON.parse(text)
}

async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await mcp('tools/call', { name, arguments: args })
  if (res.error) throw new Error(`${name} → ${JSON.stringify(res.error)}`)
  const content = res.result?.content?.[0]
  if (res.result?.isError) throw new Error(`${name} isError → ${content?.text}`)
  return JSON.parse(content.text)
}

async function search(term: string): Promise<void> {
  const box = page.getByPlaceholder('Buscar por título…')
  await box.fill(term)
  await page.waitForTimeout(400)
}

async function openFeature(term: string, expectTitle: string): Promise<string> {
  await search(term)
  const aside = page.locator('aside').first()
  await aside.getByText(expectTitle, { exact: false }).first().click()
  const doc = page.locator('header').filter({ has: page.locator('h1') }).first()
  await doc.locator('h1').waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(1500)
  return (await doc.locator('h1').innerText()).trim()
}

// Volta pra parede. Ela so existe com selectedId === null, e o dossie nao tem
// gesto de "fechar" — se a ida-e-volta de area nao bastar, o reload do renderer
// e o unico caminho, e isso e um achado, nao um detalhe do driver.
async function backToWall(): Promise<'area' | 'reload' | 'nenhum'> {
  await goToArea(page, 'projects')
  await page.waitForTimeout(500)
  await goToArea(page, 'features')
  await page.waitForTimeout(1200)
  if (await page.locator('[data-testid="feature-wall"]').isVisible().catch(() => false)) return 'area'
  await page.reload()
  await waitReady(page)
  await goToArea(page, 'features')
  await page.waitForTimeout(2500)
  return (await page.locator('[data-testid="feature-wall"]').isVisible().catch(() => false))
    ? 'reload'
    : 'nenhum'
}

const PULSE = 'Fases 3 e 4 validadas no app buildado — parede default e resume herdando a feature.'

try {
  await waitReady(page)

  // ---- seed via MCP: pulso + ledger na feature A (o banco real e anterior as
  // migrations do loop, entao nao ha pulso nenhum na copia). --------------
  await callTool('feature_pulse_set', { featureId: FEAT_A_ID, body: PULSE })
  await callTool('feature_ledger_append', {
    featureId: FEAT_A_ID,
    entryId: 'fase-3-4',
    title: 'Integracao com o Claude Code e parede de features',
    kind: 'shipped',
    body: 'resume herda featureId; parede virou a view default.',
  })

  // ================= PASSO 2 — parede default, pin/unpin, dossie ==========
  await goToArea(page, 'features')
  await page.waitForTimeout(2500)

  const wall = page.locator('[data-testid="feature-wall"]')
  check('Features abre na view PAREDE (default)', await wall.isVisible())
  await shot('loop34-01-wall-default')

  const emptyFocus = page.locator('[data-testid="feature-wall-empty-focus"]')
  const startedEmpty = await emptyFocus.isVisible().catch(() => false)
  log(`estado inicial do "Em foco": ${startedEmpty ? 'vazio' : `${await page.locator('[data-testid="feature-wall-card"]').count()} card(s)`}`)

  // pin pelo convite do vazio (ou, se ja houver pinada, pelo botao da lista)
  if (startedEmpty) {
    const sugg = page.locator('[data-testid="feature-wall-pin-suggestion"]')
    const suggText = (await sugg.innerText()).trim()
    log(`clicando: ${JSON.stringify(suggText)}`)
    await sugg.click()
    await page.waitForTimeout(1500)
  } else {
    await page.locator('[data-testid="feature-card-pin"]').first().click()
    await page.waitForTimeout(1500)
  }
  const afterPin = await page.locator('[data-testid="feature-wall-card"]').count()
  check('pinar cria card em "Em foco"', afterPin >= 1, `cards=${afterPin}`)
  check('o convite do vazio some depois de pinar', !(await emptyFocus.isVisible().catch(() => false)))
  const pinnedTitle = afterPin ? (await page.locator('[data-testid="feature-wall-card"]').first().innerText()).split('\n')[0] : ''
  log(`card em foco: ${JSON.stringify(pinnedTitle)}`)
  await shot('loop34-02-wall-pinned')

  // unpin pelo card e conferir que a parede volta ao estado anterior
  await page.locator('[data-testid="feature-wall-unpin"]').first().click()
  await page.waitForTimeout(1500)
  const afterUnpin = await page.locator('[data-testid="feature-wall-card"]').count()
  check('despinar remove o card de "Em foco"', afterUnpin === afterPin - 1, `${afterPin} → ${afterUnpin}`)
  await shot('loop34-03-wall-unpinned')

  // dossie da feature A
  const titleA = await openFeature('Comunicação pós', FEAT_A_TITLE)
  log(`dossie aberto: ${JSON.stringify(titleA)}`)
  check('abriu a feature alvo', titleA.includes('Comunicação pós-protocolização'))
  const liveness = page.locator('[data-testid="liveness-chip"]')
  check('chip de liveness presente', await liveness.isVisible(), (await liveness.innerText().catch(() => '')).trim())
  const docText = await page.locator('body').innerText()
  // O pulso nao tem cabecalho "Pulso": ELE E a manchete do dossie, logo abaixo
  // do titulo, com o chip de origem ao lado da data.
  const pulseSource = page.locator('[data-testid="pulse-source"]').first()
  check('bloco de pulso presente (chip de origem)', await pulseSource.isVisible(), (await pulseSource.innerText().catch(() => '')).trim())
  check('o pulso gravado aparece no dossiê', docText.includes('Fases 3 e 4 validadas no app buildado'))
  const issues = page.locator('[data-testid="feature-issues"]')
  const hasIssues = await issues.isVisible().catch(() => false)
  log(`faixa de higiene: ${hasIssues ? 'presente — ' + (await issues.innerText()).replace(/\n/g, ' | ').slice(0, 200) : 'ausente (nenhuma issue)'}`)
  await shot('loop34-04-dossier')

  // ================= PASSO 3 — a integracao ===============================
  const sessionsBlock = page.locator('[data-testid="feature-sessions"]')
  check('FeatureSessions renderizou', await sessionsBlock.isVisible())
  const rows = page.locator('[data-testid="feature-session-action"]')
  const nRows = await rows.count()
  const actions = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.action))
  check('lista traz as sessões da feature', nRows > 0, `n=${nRows} ações=${JSON.stringify(actions.slice(0, 6))}`)
  check('sessões mortas oferecem "retomar"', actions.every((a) => a === 'resume' || a === 'focus'), JSON.stringify([...new Set(actions)]))
  await sessionsBlock.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await shot('loop34-05-feature-sessions')

  // "Trabalhar nesta feature" — abre o dialogo, NAO confirma o spawn
  await page.locator('[data-testid="feature-work-button"]').click()
  await page.waitForTimeout(1200)
  const select = page.locator('[data-testid="spawn-feature-select"]')
  check('o diálogo de nova sessão abriu', await select.isVisible())
  const selected = await select.inputValue()
  check('feature já vem preenchida no diálogo', selected === FEAT_A_ID, `value=${selected}`)
  // O repo escolhido para a sessao e o titulo do dialogo — "Nova sessao · <repo>".
  const dialogTitle = (await page.getByRole('heading', { name: /^Nova sessão · / }).first().innerText()).trim()
  check('repo pré-selecionado no título do diálogo', dialogTitle === `Nova sessão · ${FEAT_A_REPO_LABEL}`, dialogTitle)
  const selectedLabel = await select.locator('option:checked').innerText().catch(() => '')
  log(`option selecionada: ${JSON.stringify(selectedLabel.trim())}`)
  await shot('loop34-06-spawn-dialog-prefilled')
  // fecha SEM abrir sessao nenhuma
  await page.getByRole('button', { name: 'Cancelar' }).first().click()
  await page.waitForTimeout(600)
  check('diálogo fechou sem abrir sessão', !(await select.isVisible().catch(() => false)))

  // feature SEM repo: nota explicativa em vez de botao morto
  const titleB = await openFeature('Video Lab', FEAT_B_TITLE)
  log(`dossie sem repo: ${JSON.stringify(titleB)}`)
  await page.locator('[data-testid="feature-work-button"]').click()
  await page.waitForTimeout(800)
  const note = page.locator('[data-testid="feature-work-no-repo"]')
  check('feature sem repo mostra a nota explicativa', await note.isVisible(), (await note.innerText().catch(() => '')).replace(/\n/g, ' '))
  check('nenhum diálogo de sessão abriu para feature sem repo', !(await page.locator('[data-testid="spawn-feature-select"]').isVisible().catch(() => false)))
  await shot('loop34-07-no-repo-note')

  // ================= PASSO 5 — MCP feature_pin ============================
  const listed = await mcp('tools/list')
  const names: string[] = (listed.result?.tools ?? []).map((t: any) => t.name)
  log(`tools/list devolveu ${names.length} tools`)
  check('feature_pin aparece em tools/list', names.includes('feature_pin'))
  const pinRes = await callTool('feature_pin', { featureId: FEAT_A_ID })
  log(`feature_pin → ${JSON.stringify(pinRes)}`)
  check('feature_pin devolve o foco ligado', pinRes.focus?.pinned === true, JSON.stringify(pinRes.focus))
  check('feature_pin devolve o veredito de duplicata', 'duplicateSuspect' in pinRes, JSON.stringify(pinRes.duplicateSuspect))

  // e a parede reflete o pin feito por fora da UI
  const via = await backToWall()
  log(`voltar do dossie para a parede exigiu: ${via}`)
  if (via !== 'area') log(`NOTA (nao bloqueante): o dossie nao tem gesto de voltar para a parede — precisou de ${via}`)
  const wallCards = page.locator('[data-testid="feature-wall-card"]')
  const wallTexts = await wallCards.allInnerTexts()
  check(
    'a parede reflete o pin vindo do MCP',
    wallTexts.some((t) => t.includes('Comunicação pós-protocolização')),
    `cards=${wallTexts.length}`,
  )
  await shot('loop34-08-wall-after-mcp-pin')

  // Home ('overview' no IconRail) lista as features em foco
  await page.getByTitle(/^Home($| ·)/).first().click()
  await page.waitForTimeout(2000)
  const home = page.locator('[data-testid="home-pinned-features"]')
  const homeVisible = await home.isVisible().catch(() => false)
  check(
    'Home mostra as features em foco',
    homeVisible && (await home.innerText()).includes('Comunicação pós-protocolização'),
    homeVisible ? (await home.innerText()).replace(/\n/g, ' | ').slice(0, 180) : 'bloco não renderizou',
  )
  await shot('loop34-09-home-pinned')
} catch (err) {
  ok = false
  log(`ERRO: ${(err as Error).stack ?? (err as Error).message}`)
  await screenshot(page, 'loop34-99-error').catch(() => {})
} finally {
  stop()
  await app.close()
}

check(`zero pageerror/console.error no renderer (${rendererErrors.length})`, rendererErrors.length === 0, rendererErrors.slice(0, 6).join(' ;; '))

// Depois do close o WAL foi checkpointado: agora o app.db conta a verdade.
const pinnedRows = await queryDb<{ id: string; title: string; pinned: number }>(
  userDataCopy,
  "SELECT id, substr(title,1,40) AS title, pinned, focus_rank FROM features WHERE pinned = 1",
)
log(`banco pós-close · features pinned: ${JSON.stringify(pinnedRows)}`)
check('o pin do MCP persistiu no banco', pinnedRows.some((r) => r.id === FEAT_A_ID))

copyFileSync(join(userDataCopy, 'app.db'), DB_OUT)
log(`app.db salvo para o PASSO 4: ${DB_OUT}`)

for (const s of shots) log(`screenshot: ${s}`)
log(`log: ${logFile}`)
log(ok ? 'RESULTADO: PASS' : 'RESULTADO: FAIL')
process.exit(ok ? 0 : 1)
