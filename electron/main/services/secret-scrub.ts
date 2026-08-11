import { resolve, sep } from 'node:path'
import { listCustomEnvEntries, writeCustomEnv } from './custom-env'

// O harness de e2e (`drive-app`) copia o userData REAL inteiro pra /tmp a cada
// run e sobe o app contra a cópia. Mesmo com os segredos cifrados em repouso, a
// cópia roda como o mesmo usuário do SO — o cofre decifra normalmente. Então o
// app, ao subir contra um perfil descartável, troca os valores por um
// placeholder: a cópia deixa de conter segredo utilizável e os testes que só
// checam "a chave está configurada" continuam passando.
//
// O valor precisa ser NÃO-VAZIO: o app usa `Boolean(getEnvVar(...))` para decidir
// se a integração está ligada (ex.: banner "busca web desligada" nos Dossiês).
export const DISPOSABLE_SECRET_PLACEHOLDER = 'drive-app-placeholder'

export const SCRUB_ENV_FLAG = 'CM_SCRUB_SECRETS'

export function isInsideDir(parent: string, child: string): boolean {
  const p = resolve(parent)
  const c = resolve(child)
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

// Guarda dupla, deliberada: a flag sozinha (herdada por engano no ambiente) não
// pode destruir as chaves do perfil real do usuário. Só apaga se o userData
// também estiver dentro do tmpdir — o que só acontece na cópia do harness.
export function shouldScrubProfile(
  env: NodeJS.ProcessEnv,
  userDataPath: string,
  tmpDir: string,
): boolean {
  if (env[SCRUB_ENV_FLAG] !== '1') return false
  return isInsideDir(tmpDir, userDataPath)
}

// Substitui TODO valor de env var customizada pelo placeholder, preservando os
// nomes das chaves (é deles que a UI e os gates de integração dependem).
export function scrubProfileSecrets(): number {
  const entries = listCustomEnvEntries()
  if (entries.length === 0) return 0
  const scrubbed: Record<string, string> = {}
  for (const entry of entries) scrubbed[entry.key] = DISPOSABLE_SECRET_PLACEHOLDER
  writeCustomEnv(scrubbed)
  return entries.length
}
