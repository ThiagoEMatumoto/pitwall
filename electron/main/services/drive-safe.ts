// Modo seguro do harness de e2e (drive-app). A cópia do userData protege o
// banco, não o filesystem nem o hardware: sem este gate, um drive rodou
// `git pull` em 38 repos reais (auto-pull) e a detecção de reunião reagiu ao
// microfone real. Com CM_DRIVE_SAFE=1, jobs de background que tocam coisas
// fora do userData não sobem. Ações explícitas do usuário (botões) seguem
// funcionando — o gate só cobre o que roda sozinho.

type Env = Record<string, string | undefined>

export function isDriveSafe(env: Env = process.env): boolean {
  return env.CM_DRIVE_SAFE === '1'
}

const announced = new Set<string>()

// true = o job NÃO deve rodar. Loga uma vez por job, para o log do boot servir
// de evidência de que o gate pegou.
export function driveSafeBlocks(job: string, env: Env = process.env): boolean {
  if (!isDriveSafe(env)) return false
  if (!announced.has(job)) {
    announced.add(job)
    console.log(`[drive-safe] ${job} disabled`)
  }
  return true
}

export function _resetDriveSafeForTests(): void {
  announced.clear()
}
