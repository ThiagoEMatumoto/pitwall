import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from './migrations/index'

// Mesmo padrão do repo-dependency-store.test: o store importa getDb de './db'
// (que depende de electron.app); mockamos pra um SQLite in-memory migrado.
let testDb: Database.Database
vi.mock('./db', () => ({
  getDb: () => testDb,
}))

// O `resumable` derivado no toEntity bate no disco (findTranscriptPath varre
// ~/.claude/projects). Aqui o transcript é uma variável — é o único eixo que o
// teste quer controlar.
let transcriptPath: string | null = null
vi.mock('./transcript-path', () => ({
  findTranscriptPath: () => transcriptPath,
}))

import * as store from './handoff-store'

function applyAllMigrations(db: Database.Database): void {
  for (const m of migrations) {
    if (m.disableForeignKeys) {
      db.pragma('foreign_keys = OFF')
      try {
        m.up(db)
      } finally {
        db.pragma('foreign_keys = ON')
      }
    } else {
      m.up(db)
    }
  }
}

function seed(db: Database.Database): void {
  db.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',?,?)`).run(
    Date.now(),
    Date.now(),
  )
  db.prepare(
    `INSERT INTO repos (id, project_id, label, path, position, created_at)
     VALUES ('r1','p1','Repo 1','/tmp/r1',0,?), ('r2','p1','Repo 2','/tmp/r2',1,?)`,
  ).run(Date.now(), Date.now())
}

function newHandoff(targetRepoId = 'r1') {
  return store.create({
    targetRepoId,
    task: 'do thing',
    composedPrompt: 'prompt',
  })
}

describe('handoff-store', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
    seed(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  describe('create + mode', () => {
    it('default mode = interactive quando omitido', () => {
      const h = newHandoff()
      expect(h.mode).toBe('interactive')
      expect(h.currentStep).toBeNull()
      expect(h.stepUpdatedAt).toBeNull()
    })

    it('respeita o mode passado', () => {
      const h = store.create({
        targetRepoId: 'r1',
        task: 't',
        composedPrompt: 'p',
        mode: 'auto-edits',
      })
      expect(h.mode).toBe('auto-edits')
    })
  })

  describe('progress (não-terminal)', () => {
    it('grava current_step só quando running; NÃO vira done', () => {
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's-child')
      const after = store.progress(h.id, 'rodando testes')
      expect(after.status).toBe('running')
      expect(after.currentStep).toBe('rodando testes')
      expect(after.stepUpdatedAt).not.toBeNull()
    })

    it('ignora progress quando NÃO está running (ex.: pending)', () => {
      const h = newHandoff() // pending
      const after = store.progress(h.id, 'cedo demais')
      expect(after.currentStep).toBeNull()
    })
  })

  describe('ask / resume (canal pergunta filha→mãe)', () => {
    it('ask: running → needs_input, grava pergunta + timestamp', () => {
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's-child')
      const after = store.ask(h.id, 'qual versão do node?')
      expect(after.status).toBe('needs_input')
      expect(after.pendingQuestion).toBe('qual versão do node?')
      expect(after.questionAskedAt).not.toBeNull()
    })

    it('ask: NÃO transiciona fora do estado vivo (ex.: pending)', () => {
      const h = newHandoff() // pending
      const after = store.ask(h.id, 'cedo demais')
      expect(after.status).toBe('pending')
      expect(after.pendingQuestion).toBeNull()
      expect(events(h.id).map((e) => e.event)).toEqual(['create'])
    })

    // REGRESSÃO: a 2ª pergunta seguida era descartada em silêncio (o UPDATE só
    // pegava status='running', então virava no-op SEM evento — bloqueio invisível).
    it('ask durante needs_input EMPILHA a 2ª pergunta em vez de descartá-la', () => {
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's-child')
      const first = store.ask(h.id, 'qual lib de validação?')
      const after = store.ask(h.id, 'e posso mexer no schema?')

      expect(after.status).toBe('needs_input')
      expect(after.pendingQuestion).toBe('qual lib de validação?\n\ne posso mexer no schema?')
      // "bloqueada desde" = instante da PRIMEIRA pergunta.
      expect(after.questionAskedAt).toBe(first.questionAskedAt)
      const asks = events(h.id).filter((e) => e.event === 'ask')
      expect(asks.map((e) => e.detail)).toEqual([
        'qual lib de validação?',
        'e posso mexer no schema?',
      ])
      expect(asks[1]).toMatchObject({ from_status: 'needs_input', to_status: 'needs_input' })
    })

    it('ask após resume começa uma pergunta NOVA (não empilha na já respondida)', () => {
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's-child')
      store.ask(h.id, 'primeira')
      store.resume(h.id)
      const after = store.ask(h.id, 'segunda')
      expect(after.pendingQuestion).toBe('segunda')
    })

    it('resume: needs_input → running e limpa a pergunta', () => {
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's-child')
      store.ask(h.id, 'pergunta')
      const after = store.resume(h.id)
      expect(after.status).toBe('running')
      expect(after.pendingQuestion).toBeNull()
      expect(after.questionAskedAt).toBeNull()
    })

    it('resume: idempotente fora de needs_input (running permanece running)', () => {
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's-child')
      const after = store.resume(h.id)
      expect(after.status).toBe('running')
    })

    // REGRESSÃO (bug medido no DB real: 3 de 12 perguntas morreram assim). A filha
    // perguntava, seguia trabalhando, chamava handoff_progress — e o progresso
    // apagava a própria pergunta, devolvendo o status pra running. A mãe nunca via
    // o bloqueio.
    it('progress durante needs_input PRESERVA a pergunta e o status (só a mãe encerra)', () => {
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's-child')
      const asked = store.ask(h.id, 'qual lib de validação?')
      const after = store.progress(h.id, 'segui pelo caminho A enquanto espero')

      expect(after.status).toBe('needs_input')
      expect(after.pendingQuestion).toBe('qual lib de validação?')
      expect(after.questionAskedAt).toBe(asked.questionAskedAt)
      // O passo é gravado mesmo assim: a UI continua vendo a filha avançar.
      expect(after.currentStep).toBe('segui pelo caminho A enquanto espero')
    })

    it('progress durante needs_input loga needs_input → needs_input (não forja um resume)', () => {
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's-child')
      store.ask(h.id, 'pergunta')
      store.progress(h.id, 'passo durante o bloqueio')

      expect(events(h.id).at(-1)).toMatchObject({
        event: 'progress',
        from_status: 'needs_input',
        to_status: 'needs_input',
        detail: 'passo durante o bloqueio',
      })
    })

    it('só o resume (resposta da mãe) encerra a pergunta, mesmo após progressos', () => {
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's-child')
      store.ask(h.id, 'pergunta')
      store.progress(h.id, 'passo 1')
      store.progress(h.id, 'passo 2')
      expect(store.get(h.id)?.pendingQuestion).toBe('pergunta')

      const after = store.resume(h.id)
      expect(after.status).toBe('running')
      expect(after.pendingQuestion).toBeNull()
      expect(after.questionAskedAt).toBeNull()
      // O último passo reportado sobrevive ao resume.
      expect(after.currentStep).toBe('passo 2')
    })
  })

  describe('report duplicado', () => {
    // REGRESSÃO: aconteceu 2× no DB real (done→done). O 2º report sobrescrevia o
    // summary já consumido pela mãe e passava como sucesso indistinguível.
    it('2º report preserva o summary original e loga reportDuplicate', () => {
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's-child')
      store.report(h.id, 'resultado original')
      const after = store.report(h.id, 'resultado repetido')

      expect(after.status).toBe('done')
      expect(after.summary).toBe('resultado original')
      expect(events(h.id).at(-1)).toMatchObject({
        event: 'reportDuplicate',
        from_status: 'done',
        to_status: 'done',
        detail: 'resultado repetido',
      })
    })

    it('report a partir de interrupted ainda conclui (retomada legítima)', () => {
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's-child')
      store.failIfRunning(h.id, 'filha morreu')
      const after = store.report(h.id, 'terminei depois de retomar')
      expect(after.status).toBe('done')
      expect(after.summary).toBe('terminei depois de retomar')
    })
  })

  describe('failIfRunning (reconciliação de morte da filha → interrupted)', () => {
    it('running → interrupted (recuperável, NÃO failed) e retorna o handoff', () => {
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's-child')
      const res = store.failIfRunning(h.id, 'filha morreu')
      expect(res).not.toBeNull()
      expect(res?.status).toBe('interrupted')
      expect(res?.error).toBe('filha morreu')
    })

    it('loga o evento de transição (interrupt) com from/to corretos', () => {
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's-child')
      store.failIfRunning(h.id, 'filha morreu')
      expect(events(h.id).at(-1)).toMatchObject({
        event: 'interrupt',
        from_status: 'running',
        to_status: 'interrupted',
      })
    })

    it('NÃO sobrescreve done: retorna null e mantém done', () => {
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's-child')
      store.report(h.id, 'concluído')
      const res = store.failIfRunning(h.id, 'morte tardia')
      expect(res).toBeNull()
      expect(store.get(h.id)?.status).toBe('done')
    })

    it('needs_input → interrupted (a filha que perguntou e morreu vira recuperável)', () => {
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's-child')
      store.ask(h.id, 'pergunta')
      const res = store.failIfRunning(h.id, 'PTY morreu durante a espera')
      expect(res?.status).toBe('interrupted')
    })
  })

  describe('getByChildSession', () => {
    it('acha o handoff pela sessão-filha', () => {
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's-child-xyz')
      expect(store.getByChildSession('s-child-xyz')?.id).toBe(h.id)
      expect(store.getByChildSession('inexistente')).toBeNull()
    })
  })

  // Helper: cria uma session-filha viva/morta na tabela sessions e atrela ao
  // handoff (markRunning). Espelha o que o fluxo real faz no spawn da filha.
  function spawnChild(handoffId: string, childSessionId: string, childStatus: string): void {
    testDb
      .prepare(
        `INSERT INTO sessions (id, repo_id, status, started_at) VALUES (?, 'r1', ?, ?)`,
      )
      .run(childSessionId, childStatus, Date.now())
    store.markRunning(handoffId, childSessionId)
  }

  describe('boot sweep (handoffs órfãos do boot anterior → interrupted)', () => {
    // O sweep vive em db.ts (getDb), acoplado a electron.app; aqui exercemos o
    // MESMO SQL literal contra o testDb pra travar o contrato.
    function bootSweep(): void {
      testDb
        .prepare(
          "UPDATE handoffs SET status = 'interrupted', error = ?, updated_at = ? WHERE status IN ('running','needs_input')",
        )
        .run('Sessão-filha órfã: app reiniciou sem reconciliar o handoff', Date.now())
    }

    it("running/needs_input → interrupted; done/rejected/failed permanecem intactos", () => {
      const running = newHandoff('r1')
      store.approve(running.id, {})
      store.markRunning(running.id, 's-run')

      // needs_input também é órfão no boot (a filha que perguntou morreu junto).
      const asking = newHandoff('r1')
      store.approve(asking.id, {})
      store.markRunning(asking.id, 's-ask')
      store.ask(asking.id, 'pergunta órfã')

      const done = newHandoff('r2')
      store.approve(done.id, {})
      store.markRunning(done.id, 's-done')
      store.report(done.id, 'ok')

      const rejected = newHandoff('r1')
      store.reject(rejected.id)

      const failed = newHandoff('r2')
      store.fail(failed.id, 'erro original')

      bootSweep()

      const swept = store.get(running.id)
      expect(swept?.status).toBe('interrupted')
      expect(swept?.error).toBe('Sessão-filha órfã: app reiniciou sem reconciliar o handoff')
      expect(store.get(asking.id)?.status).toBe('interrupted')
      expect(store.get(done.id)?.status).toBe('done')
      expect(store.get(rejected.id)?.status).toBe('rejected')
      // Não sobrescreve um failed (erro REAL) pré-existente.
      expect(store.get(failed.id)?.status).toBe('failed')
      expect(store.get(failed.id)?.error).toBe('erro original')
    })
  })

  describe('reconcileStuck (self-heal de filha morta em runtime → interrupted)', () => {
    it('running com filha NÃO-running → interrupted (recuperável)', () => {
      const h = newHandoff('r1')
      store.approve(h.id, {})
      spawnChild(h.id, 's-dead', 'exited')

      const n = store.reconcileStuck()
      expect(n).toBe(1)
      const after = store.get(h.id)
      expect(after?.status).toBe('interrupted')
      expect(after?.error).toBe('Sessão-filha encerrada sem reportar conclusão')
    })

    it('running com filha viva (running) → PERMANECE running (guarda de segurança)', () => {
      const h = newHandoff('r1')
      store.approve(h.id, {})
      spawnChild(h.id, 's-alive', 'running')

      const n = store.reconcileStuck()
      expect(n).toBe(0)
      expect(store.get(h.id)?.status).toBe('running')
    })

    it('needs_input com filha VIVA (session running) → PERMANECE needs_input', () => {
      const h = newHandoff('r1')
      store.approve(h.id, {})
      spawnChild(h.id, 's-asking', 'running')
      store.ask(h.id, 'pergunta')

      const n = store.reconcileStuck()
      expect(n).toBe(0)
      expect(store.get(h.id)?.status).toBe('needs_input')
    })

    it('needs_input com filha MORTA (session exited) → interrupted', () => {
      const h = newHandoff('r1')
      store.approve(h.id, {})
      spawnChild(h.id, 's-dead-ask', 'running')
      store.ask(h.id, 'pergunta')
      // Filha morreu de fato: marca a session como exited.
      testDb.prepare("UPDATE sessions SET status = 'exited' WHERE id = 's-dead-ask'").run()

      const n = store.reconcileStuck()
      expect(n).toBe(1)
      expect(store.get(h.id)?.status).toBe('interrupted')
    })

    it('running sem filha atrelada (child_session_id NULL) → interrupted', () => {
      const h = newHandoff('r1')
      store.approve(h.id, {})
      // Sem markRunning: força running diretamente, child_session_id permanece null.
      testDb.prepare("UPDATE handoffs SET status = 'running' WHERE id = ?").run(h.id)

      const n = store.reconcileStuck()
      expect(n).toBe(1)
      expect(store.get(h.id)?.status).toBe('interrupted')
    })

    it('NÃO toca handoffs em estado terminal (done permanece done)', () => {
      const h = newHandoff('r1')
      store.approve(h.id, {})
      spawnChild(h.id, 's-done', 'exited')
      store.report(h.id, 'concluído')

      const n = store.reconcileStuck()
      expect(n).toBe(0)
      expect(store.get(h.id)?.status).toBe('done')
    })

    it('NÃO re-reconcilia um interrupted já reconciliado (não conta como vivo)', () => {
      const h = newHandoff('r1')
      store.approve(h.id, {})
      spawnChild(h.id, 's-dead2', 'exited')
      expect(store.reconcileStuck()).toBe(1)
      // 2ª passada: interrupted não está em ('running','needs_input') → ignorado.
      expect(store.reconcileStuck()).toBe(0)
      expect(store.get(h.id)?.status).toBe('interrupted')
    })
  })

  // Helpers de leitura da trilha de eventos (migration 026).
  function events(handoffId: string): Array<{
    event: string
    from_status: string | null
    to_status: string
    detail: string | null
  }> {
    return testDb
      .prepare(
        'SELECT event, from_status, to_status, detail FROM handoff_events WHERE handoff_id = ? ORDER BY at ASC, rowid ASC',
      )
      .all(handoffId) as Array<{
      event: string
      from_status: string | null
      to_status: string
      detail: string | null
    }>
  }

  describe('instrumentação: handoff_events (trilha de transições)', () => {
    it('create loga 1 evento create (from null → to pending)', () => {
      const h = newHandoff()
      const ev = events(h.id)
      expect(ev).toHaveLength(1)
      expect(ev[0]).toMatchObject({ event: 'create', from_status: null, to_status: 'pending' })
    })

    it('cada mutador de status grava 1 linha com from/to corretos', () => {
      const h = newHandoff() // create → pending
      store.approve(h.id, {}) // pending → approved
      store.markRunning(h.id, 's-child') // approved → running
      store.progress(h.id, 'rodando testes') // running → running (progress)
      store.ask(h.id, 'qual versão?') // running → needs_input
      store.resume(h.id) // needs_input → running
      store.report(h.id, 'feito') // running → done

      const ev = events(h.id)
      expect(ev.map((e) => e.event)).toEqual([
        'create',
        'approve',
        'markRunning',
        'progress',
        'ask',
        'resume',
        'report',
      ])
      // Confere os pares from→to dos mutadores de status.
      expect(ev[1]).toMatchObject({ from_status: 'pending', to_status: 'approved' })
      expect(ev[2]).toMatchObject({ from_status: 'approved', to_status: 'running' })
      expect(ev[3]).toMatchObject({ from_status: 'running', to_status: 'running', detail: 'rodando testes' })
      expect(ev[4]).toMatchObject({ from_status: 'running', to_status: 'needs_input', detail: 'qual versão?' })
      expect(ev[5]).toMatchObject({ from_status: 'needs_input', to_status: 'running' })
      expect(ev[6]).toMatchObject({ from_status: 'running', to_status: 'done' })
    })

    it('NÃO loga quando a transição condicional não ocorre (progress em pending)', () => {
      const h = newHandoff() // pending
      store.progress(h.id, 'cedo demais') // no-op (não está running)
      const ev = events(h.id)
      expect(ev.map((e) => e.event)).toEqual(['create'])
    })

    it('reconcileStuck loga uma linha (interrupt) por handoff reconciliado', () => {
      const a = newHandoff('r1')
      store.approve(a.id, {})
      testDb.prepare("UPDATE handoffs SET status = 'running' WHERE id = ?").run(a.id) // child null
      const b = newHandoff('r2')
      store.approve(b.id, {})
      testDb.prepare("UPDATE handoffs SET status = 'running' WHERE id = ?").run(b.id)

      const n = store.reconcileStuck()
      expect(n).toBe(2)
      expect(events(a.id).at(-1)).toMatchObject({
        event: 'reconcileStuck',
        from_status: 'running',
        to_status: 'interrupted',
      })
      expect(events(b.id).at(-1)).toMatchObject({
        event: 'reconcileStuck',
        to_status: 'interrupted',
      })
    })

    it('fail() (erro REAL reportado) continua marcando failed, não interrupted', () => {
      const h = newHandoff('r1')
      store.approve(h.id, {})
      store.markRunning(h.id, 's')
      const after = store.fail(h.id, 'erro de tarefa real')
      expect(after.status).toBe('failed')
      expect(events(h.id).at(-1)).toMatchObject({
        event: 'fail',
        to_status: 'failed',
        detail: 'erro de tarefa real',
      })
    })
  })

  describe('create + fromRepoId', () => {
    it('persiste from_repo_id quando passado', () => {
      const h = store.create({
        targetRepoId: 'r1',
        fromRepoId: 'r2',
        task: 't',
        composedPrompt: 'p',
      })
      expect(h.fromRepoId).toBe('r2')
    })

    it('from_repo_id = null quando omitido', () => {
      const h = newHandoff()
      expect(h.fromRepoId).toBeNull()
    })
  })

  describe('markConsumed (proxy de consumo pela mãe)', () => {
    it('marca consumed_at + loga consume só quando done', () => {
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's')
      store.report(h.id, 'ok')

      const after = store.markConsumed(h.id)
      expect(after.consumedAt).not.toBeNull()
      expect(events(h.id).at(-1)).toMatchObject({ event: 'consume', to_status: 'done' })
    })

    it('idempotente: 2ª chamada não muda consumed_at nem duplica evento', () => {
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's')
      store.report(h.id, 'ok')

      const first = store.markConsumed(h.id)
      const second = store.markConsumed(h.id)
      expect(second.consumedAt).toBe(first.consumedAt)
      const consumeEvents = events(h.id).filter((e) => e.event === 'consume')
      expect(consumeEvents).toHaveLength(1)
    })

    it('não marca quando NÃO está done (ex.: running)', () => {
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's')
      const after = store.markConsumed(h.id)
      expect(after.consumedAt).toBeNull()
      expect(events(h.id).some((e) => e.event === 'consume')).toBe(false)
    })
  })

  describe('setOutcome (feedback humano)', () => {
    it('persiste o outcome e loga feedback com o status corrente', () => {
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's')
      store.report(h.id, 'ok')

      const after = store.setOutcome(h.id, 'useful')
      expect(after.outcome).toBe('useful')
      expect(events(h.id).at(-1)).toMatchObject({
        event: 'feedback',
        from_status: 'done',
        to_status: 'done',
        detail: 'useful',
      })
    })

    it('permite revisar o outcome (sobrescreve)', () => {
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's')
      store.report(h.id, 'ok')
      store.setOutcome(h.id, 'wrong')
      const after = store.setOutcome(h.id, 'partial')
      expect(after.outcome).toBe('partial')
      const feedback = events(h.id).filter((e) => e.event === 'feedback')
      expect(feedback).toHaveLength(2)
    })
  })

  describe('isActiveCrewChild (silencia a notificação nativa que o dock já dá)', () => {
    function seedSession(id: string, ccSessionId: string): void {
      testDb
        .prepare(
          `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at)
           VALUES (?, 'r1', ?, 'running', ?)`,
        )
        .run(id, ccSessionId, Date.now())
    }

    it('filha de handoff running → true', () => {
      seedSession('s1', 'cc-1')
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's1')
      expect(store.isActiveCrewChild('cc-1')).toBe(true)
    })

    it('needs_input também conta (é estado vivo dentro de running)', () => {
      seedSession('s1', 'cc-1')
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's1')
      store.ask(h.id, 'posso apagar?')
      expect(store.isActiveCrewChild('cc-1')).toBe(true)
    })

    it('handoff terminal → false (a filha voltou a ser sessão comum)', () => {
      seedSession('s1', 'cc-1')
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's1')
      store.report(h.id, 'ok')
      expect(store.isActiveCrewChild('cc-1')).toBe(false)
    })

    it('sessão que não veio de handoff → false', () => {
      seedSession('s9', 'cc-avulsa')
      expect(store.isActiveCrewChild('cc-avulsa')).toBe(false)
      expect(store.isActiveCrewChild('cc-inexistente')).toBe(false)
    })

    // O silêncio aqui só se paga porque o dock avisa — e o dispensado NÃO está no
    // dock. Sem esta cláusula, dispensar viraria mordaça: a filha pediria atenção
    // e nada apareceria em superfície nenhuma.
    it('handoff DISPENSADO → false (sem card no dock, a notificação nativa volta)', () => {
      seedSession('s1', 'cc-1')
      const h = newHandoff()
      store.approve(h.id, {})
      store.markRunning(h.id, 's1')
      store.dismiss(h.id)
      expect(store.isActiveCrewChild('cc-1')).toBe(false)
    })
  })

  describe('findActiveByTarget (dedup por alvo)', () => {
    it('acha handoff ativo pro mesmo repo-alvo', () => {
      const h = newHandoff('r1')
      expect(store.findActiveByTarget('r1')?.id).toBe(h.id)
      expect(store.findActiveByTarget('r2')).toBeNull()
    })

    it('ignora handoffs em estado terminal (done/rejected/failed)', () => {
      const h = newHandoff('r1')
      store.approve(h.id, {})
      store.markRunning(h.id, 's')
      store.report(h.id, 'ok')
      expect(store.findActiveByTarget('r1')).toBeNull()
    })

    // O dedup é a porta de entrada da MCP tool session_handoff. Recusar em nome de
    // um card DISPENSADO devolveria "já existe handoff ativo neste repo" apontando
    // pra algo que o usuário não vê, não abre e não encerra.
    it('ignora handoff DISPENSADO (card invisível não recusa nova delegação)', () => {
      const global = newHandoff('r1')
      store.dismiss(global.id)
      expect(store.findActiveByTarget('r1')).toBeNull()

      const daMae = store.create({
        targetRepoId: 'r2',
        motherSessionId: 'mother-a',
        task: 't',
        composedPrompt: 'p',
      })
      store.dismiss(daMae.id)
      expect(store.findActiveByTarget('r2', 'mother-a')).toBeNull()
    })

    it('ignora interrupted (recuperável NÃO conta como ativo → libera o teto/dedup)', () => {
      const h = newHandoff('r1')
      store.approve(h.id, {})
      store.markRunning(h.id, 's')
      store.failIfRunning(h.id, 'filha morreu') // running → interrupted
      expect(store.get(h.id)?.status).toBe('interrupted')
      // Dedup libera: um novo handoff pro mesmo alvo é permitido.
      expect(store.findActiveByTarget('r1')).toBeNull()
    })

    // Escopo por sessão-mãe: sem ele, duas mães ativas compartilhavam o mesmo
    // predicado por repo e uma podia receber a filha da outra.
    describe('escopo por sessão-mãe', () => {
      const MOTHER_A = 'mother-a'
      const MOTHER_B = 'mother-b'

      const handoffOf = (motherSessionId: string | null, targetRepoId = 'r1') =>
        store.create({ targetRepoId, motherSessionId, task: 't', composedPrompt: 'p' })

      it('escopado à mãe A ignora o handoff ativo da mãe B', () => {
        const b = handoffOf(MOTHER_B)
        expect(store.findActiveByTarget('r1', MOTHER_A)).toBeNull()
        expect(store.findActiveByTarget('r1', MOTHER_B)?.id).toBe(b.id)
      })

      it('acha o próprio handoff mesmo com outra mãe ativa no mesmo repo', () => {
        handoffOf(MOTHER_B)
        const a = handoffOf(MOTHER_A)
        expect(store.findActiveByTarget('r1', MOTHER_A)?.id).toBe(a.id)
      })

      it('sem mãe (null/omitido) volta ao escopo GLOBAL por repo — o mais estrito', () => {
        const b = handoffOf(MOTHER_B)
        expect(store.findActiveByTarget('r1')?.id).toBe(b.id)
        expect(store.findActiveByTarget('r1', null)?.id).toBe(b.id)
        expect(store.findActiveByTarget('r1', undefined)?.id).toBe(b.id)
      })

      it('escopo por mãe NÃO enxerga handoff legado (mother_session_id null)', () => {
        const legacy = handoffOf(null)
        expect(store.findActiveByTarget('r1', MOTHER_A)).toBeNull()
        // Mas o escopo global continua barrando — é o fallback seguro.
        expect(store.findActiveByTarget('r1')?.id).toBe(legacy.id)
      })

      it('escopo por mãe respeita o repo-alvo', () => {
        handoffOf(MOTHER_A, 'r1')
        expect(store.findActiveByTarget('r2', MOTHER_A)).toBeNull()
      })
    })
  })

  // A INVARIANTE de visibilidade: um handoff com filha viva nunca pode estar
  // invisível em todas as superfícies ao mesmo tempo.
  describe('markRunning (adquirir filha viva devolve a visibilidade)', () => {
    it('zera dismissed_at: o card dispensado volta ao dock ao ganhar filha', () => {
      const h = newHandoff('r1')
      // Dispensa PERMITIDA: ainda pending, sem filha viva pra deixar órfã.
      expect(store.dismiss(h.id).dismissedAt).not.toBeNull()

      store.approve(h.id, {})
      const running = store.markRunning(h.id, 's-nasce-depois')
      expect(running.status).toBe('running')
      // Sem isto: fora do dock (dockCrew), fora da strip/switcher
      // (childSessionIds) e sem notificação (isActiveCrewChild) — uma PTY viva
      // queimando token sem nenhum lugar onde ser encontrada.
      expect(running.dismissedAt).toBeNull()
    })

    it('a filha readquirida volta a ser filha ativa pro main (notificação silenciada de novo)', () => {
      testDb
        .prepare(
          `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at)
           VALUES ('s-readq', 'r1', 'cc-readq', 'running', ?)`,
        )
        .run(Date.now())
      const h = newHandoff('r1')
      store.dismiss(h.id)
      store.approve(h.id, {})
      store.markRunning(h.id, 's-readq')
      expect(store.isActiveCrewChild('cc-readq')).toBe(true)
      expect(store.findActiveByTarget('r1')?.id).toBe(h.id)
    })
  })

  // Soltar do painel: a operação INVERSA da adoção. O que dismiss NÃO faz — cortar
  // o vínculo — é exatamente o que se testa aqui.
  describe('release (solta a filha do painel)', () => {
    it('zera child_session_id, carimba dismissed_at e preserva o id antigo no evento', () => {
      const h = newHandoff('r1')
      store.approve(h.id, {})
      spawnChild(h.id, 's-solta', 'running')

      const after = store.release(h.id)
      expect(after.childSessionId).toBeNull()
      expect(after.dismissedAt).not.toBeNull()
      // A coluna era a única referência à filha: sem o carimbo no evento, a
      // rastreabilidade dela morreria junto com o vínculo.
      expect(events(h.id).at(-1)).toMatchObject({
        event: 'release',
        from_status: 'running',
        detail: 's-solta',
      })
    })

    it('handoff liberado NÃO é tocado pelo reconcileStuck', () => {
      const h = newHandoff('r1')
      store.approve(h.id, {})
      spawnChild(h.id, 's-solta2', 'running')
      store.release(h.id)

      const before = store.get(h.id)!
      // O predicado do reconcileStuck inclui child_session_id IS NULL — se o
      // release deixasse o registro 'running', ele seria varrido e receberia o erro
      // genérico de "filha encerrada sem reportar". O release encerra antes, com o
      // motivo real, e o liberado sai do alcance da varredura.
      expect(store.reconcileStuck()).toBe(0)
      const after = store.get(h.id)!
      expect(after.status).toBe(before.status)
      expect(after.error).toBe(before.error)
      expect(after.status).toBe('interrupted')
      expect(after.error).toContain('Solta do painel')
    })

    it('NÃO reescreve o desfecho de um handoff já terminal (done permanece done)', () => {
      const h = newHandoff('r1')
      store.approve(h.id, {})
      spawnChild(h.id, 's-done-solta', 'exited')
      store.report(h.id, 'concluído')

      const after = store.release(h.id)
      expect(after.status).toBe('done')
      expect(after.summary).toBe('concluído')
      expect(after.childSessionId).toBeNull()
      expect(events(h.id).at(-1)).toMatchObject({
        event: 'release',
        from_status: 'done',
        to_status: 'done',
        detail: 's-done-solta',
      })
    })

    it('soltar de novo é no-op (não empilha eventos)', () => {
      const h = newHandoff('r1')
      store.approve(h.id, {})
      spawnChild(h.id, 's-solta3', 'running')
      store.release(h.id)
      const n = events(h.id).length

      store.release(h.id)
      expect(events(h.id)).toHaveLength(n)
    })

    it('preserva o instante da dispensa quando o card já tinha sido dispensado', () => {
      const h = newHandoff('r1')
      store.approve(h.id, {})
      spawnChild(h.id, 's-solta4', 'running')
      const dismissed = store.dismiss(h.id).dismissedAt

      expect(store.release(h.id).dismissedAt).toBe(dismissed)
    })

    it('a sessão liberada deixa de ser achada por getByChildSession', () => {
      const h = newHandoff('r1')
      store.approve(h.id, {})
      spawnChild(h.id, 's-solta5', 'running')
      expect(store.getByChildSession('s-solta5')?.id).toBe(h.id)

      store.release(h.id)
      expect(store.getByChildSession('s-solta5')).toBeNull()
    })
  })

  // O campo que decide quem CONTINUA no Crew Dock: interrompida com transcript no
  // disco é pausada, não desfecho.
  describe('resumable (derivado)', () => {
    // Cada filha entra com cc_session_id PRÓPRIO (como na vida real). Importa aqui:
    // o memo de transcript do store é por cc_session_id e vive pelo processo — dois
    // casos compartilhando o mesmo uuid veriam o resultado um do outro.
    let seq = 0

    function interrupted(opts: { ccSessionId?: string | null; child?: boolean } = {}) {
      const h = newHandoff()
      if (opts.child !== false) {
        seq++
        const sessionId = `s${seq}`
        const cc =
          opts.ccSessionId === undefined
            ? `11111111-2222-4333-8444-${String(seq).padStart(12, '0')}`
            : opts.ccSessionId
        testDb
          .prepare(
            `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at)
             VALUES (?, 'r1', ?, 'exited', ?)`,
          )
          .run(sessionId, cc, Date.now())
        store.markRunning(h.id, sessionId)
      }
      store.failIfRunning(h.id, 'morreu')
      return store.get(h.id)!
    }

    it('interrompido + transcript no disco → true', () => {
      transcriptPath = '/tmp/t.jsonl'
      expect(interrupted().resumable).toBe(true)
    })

    it('interrompido sem transcript → false', () => {
      transcriptPath = null
      expect(interrupted().resumable).toBe(false)
    })

    it('cc_session_id ausente ou fora do formato UUID → false (nada a resumir)', () => {
      transcriptPath = '/tmp/t.jsonl'
      expect(interrupted({ ccSessionId: null }).resumable).toBe(false)
      expect(interrupted({ ccSessionId: 'nao-e-uuid' }).resumable).toBe(false)
    })

    // O short-circuit que segura o custo: só linha interrompida COM filha atrelada
    // chega a tocar o disco.
    it('status vivo/terminal sai false sem consultar o transcript', () => {
      transcriptPath = '/tmp/t.jsonl'
      const running = newHandoff()
      expect(store.get(running.id)!.resumable).toBe(false)
      const done = store.report(newHandoff().id, 'ok')
      expect(done.resumable).toBe(false)
    })

    it('interrompido sem filha atrelada → false', () => {
      transcriptPath = '/tmp/t.jsonl'
      expect(interrupted({ child: false }).resumable).toBe(false)
    })

    // O memo de transcript não é eterno: o .jsonl é arquivo de terceiro (o Claude
    // Code escreve, limpeza manual apaga) e o app fica dias aberto. Memo eterno =
    // card oferecendo "Retomar" pra uma conversa que já não existe até reiniciar.
    it('o carimbo do memo expira: transcript apagado deixa de ser retomável sem reiniciar o app', () => {
      vi.useFakeTimers()
      try {
        transcriptPath = '/tmp/t.jsonl'
        const h = interrupted()
        expect(h.resumable).toBe(true)

        // Apagado do disco por fora, com o app aberto.
        transcriptPath = null
        // Dentro da janela o memo ainda vale — é ele que segura o custo das
        // rajadas de recarga da lista.
        expect(store.get(h.id)!.resumable).toBe(true)

        vi.advanceTimersByTime(31_000)
        expect(store.get(h.id)!.resumable).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
