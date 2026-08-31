/**
 * PASSO 4 — a prova que fecha a Fase 3, SEM abrir sessao do Claude.
 *
 * Chama `buildSessionSystemPrompt` (a funcao compartilhada que spawn E resume
 * usam) contra um app.db real e imprime o texto gerado. Se o bloco da feature
 * sair com pulso, vitalidade e o ponteiro `.pitwall/`, o resume passa a nascer
 * com exatamente o contexto que antes se perdia.
 *
 * Roda fora do Electron: `electron` e resolvido por um loader stub que aponta
 * app.getPath('userData') pro diretorio passado em CM_USERDATA.
 *
 *   node --import ./e2e/scenarios/register-userdata-stub.mjs \
 *        --import tsx e2e/scenarios/probe-feature-system-prompt.mts
 */
import { buildSessionSystemPrompt } from '../../electron/main/ipc/session-system-prompt'
import { getDb } from '../../electron/main/services/db'

const FEATURE_ID = process.env.CM_FEATURE_ID ?? ''
if (!FEATURE_ID) throw new Error('CM_FEATURE_ID obrigatorio')

let ok = true
const check = (label: string, cond: boolean, extra = '') => {
  if (!cond) ok = false
  console.log(`[passo4] ${cond ? 'OK  ' : 'FALHA'} ${label}${extra ? ' :: ' + extra : ''}`)
}

const db = getDb()
const feat = db
  .prepare('SELECT id, slug, title, status FROM features WHERE id = ?')
  .get(FEATURE_ID) as { id: string; slug: string; title: string; status: string } | undefined
if (!feat) throw new Error(`feature ${FEATURE_ID} nao existe neste banco`)
const repoId = (
  db.prepare('SELECT repo_id FROM feature_repos WHERE feature_id = ? LIMIT 1').get(FEATURE_ID) as
    | { repo_id: string }
    | undefined
)?.repo_id
console.log(`[passo4] feature: ${feat.title} (slug=${feat.slug}) repo=${repoId ?? 'nenhum'}`)

// EXATAMENTE a chamada que o handler de `sessions:resume` faz (sessions.ts:928).
const prompt = buildSessionSystemPrompt({ repoId, featureId: FEATURE_ID })
console.log('----8<---- system prompt injetado no resume ----8<----')
console.log(prompt)
console.log('----8<---------------------------------------8<----')

check('o resume produz um system prompt', typeof prompt === 'string' && prompt.length > 0)
const text = prompt ?? ''
check('traz o titulo da feature', text.includes(feat.title))
check('traz o PULSO vigente', /Pulso vigente: /.test(text), (text.match(/Pulso vigente: .*/) ?? [''])[0])
// A vitalidade sai no valor cru do enum (alive/quiet/stale/...), nao no rotulo
// traduzido que a UI mostra no chip.
check('traz a VITALIDADE (liveness)', /· vitalidade: [a-z_-]+/.test(text), (text.match(/Status atual: .*/) ?? [''])[0])
check('traz o ponteiro do loop em .pitwall/', /Loop desta frente no disco: .*\.pitwall\/loop-.*\.md/.test(text), (text.match(/Loop desta frente no disco: .*/) ?? [''])[0])
check('traz o indice do ledger', /Últimas mudanças registradas:/.test(text))
check('traz o featureId real pro tracking', text.includes(`feature id is ${FEATURE_ID}`))

console.log(`[passo4] RESULTADO: ${ok ? 'PASS' : 'FAIL'}`)
process.exit(ok ? 0 : 1)
