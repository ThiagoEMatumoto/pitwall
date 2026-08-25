import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, normalize, sep } from 'node:path'
import { parseDotenv } from '../../../shared/dotenv-parse'
import type {
  ApplyImportResult,
  EnvSourceRef,
  ImportCandidate,
  ImportSelection,
} from '../../../shared/types/ipc'
import { SERVICE_REGISTRY, type ServiceId } from '../../../shared/service-registry'
import { readCustomEnv, setCustomEnvVar, type CustomEnvVars } from './custom-env'
import { SECRET_MASK } from './secret-store'

// Importador de .env: varre ~/projetos (e ~/.config/voz/voz.env) atrás de
// credenciais que o usuário já tem espalhadas e as compara com o cofre
// (custom-env). O VALOR nunca sai deste módulo em direção ao renderer: o scan
// devolve só um fingerprint (máscara + tamanho, últimos 4 chars quando longo)
// e o apply RELÊ o arquivo escolhido na hora de gravar via setCustomEnvVar —
// depois de revalidar que o path satisfaz as MESMAS regras do scan.

export type { ApplyImportResult, EnvSourceRef, ImportCandidate, ImportSelection }

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.worktrees',
  '.claude',
  '.venv',
  'venv',
  'dist',
  'build',
  'target',
  'vendor',
  '.next',
])
const MAX_DEPTH = 5
const ENV_FILE = /^\.env(\..+)?$/
// Arquivo .env real não chega perto disso; acima é dump/binário renomeado.
export const MAX_ENV_FILE_BYTES = 1024 * 1024

interface StatLike {
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
  size: number
}

// Dependências injetáveis (padrão VoiceDeps: teste sem fs/banco reais).
export interface EnvImportDeps {
  home: string
  listDir: (p: string) => string[]
  // lstat, nunca stat: symlink aparece como symlink e NÃO é seguido.
  lstat: (p: string) => StatLike | null
  readFile: (p: string) => string
  readCustomEnv: () => CustomEnvVars
  setEnvVar: (key: string, value: string) => { plaintext: string[] }
}

function withDefaults(over: Partial<EnvImportDeps>): EnvImportDeps {
  return {
    // CM_ENV_IMPORT_ROOT: raiz alternativa pro e2e apontar uma árvore fixture.
    // Sem a env var (produção) o scan parte do home real.
    home: process.env.CM_ENV_IMPORT_ROOT || homedir(),
    listDir: (p) => readdirSync(p),
    lstat: (p) => lstatSync(p, { throwIfNoEntry: false }) ?? null,
    readFile: (p) => readFileSync(p, 'utf8'),
    readCustomEnv,
    setEnvVar: setCustomEnvVar,
    ...over,
  }
}

function isEnvFile(name: string): boolean {
  if (!ENV_FILE.test(name)) return false
  return !name.endsWith('.example') && !name.endsWith('.template')
}

async function collectEnvFiles(root: string, d: EnvImportDeps): Promise<string[]> {
  const found: string[] = []
  let visited = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    // O walk é sync por dentro (deps sync, testáveis), mas devolve o event loop
    // a cada punhado de diretórios pra não congelar o main em árvores grandes.
    if (++visited % 20 === 0) await new Promise((resolve) => setImmediate(resolve))
    let names: string[]
    try {
      names = [...d.listDir(dir)].sort()
    } catch {
      return
    }
    for (const name of names) {
      const path = join(dir, name)
      const st = d.lstat(path)
      if (!st || st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name) && depth < MAX_DEPTH) await walk(path, depth + 1)
      } else if (st.isFile() && isEnvFile(name) && st.size <= MAX_ENV_FILE_BYTES) {
        found.push(path)
      }
    }
  }
  await walk(root, 0)
  return found
}

// Máscara + tamanho; últimos 4 chars SÓ quando o valor é longo o bastante pra
// que eles não entreguem uma fração significativa do segredo (senhas curtas
// tipo "hunter2" vazariam quase inteiras num slice(-4)).
export function secretFingerprint(value: string): string {
  if (value.length < 12) return `${SECRET_MASK} (${value.length})`
  return `${SECRET_MASK}${value.slice(-4)} (${value.length})`
}

function registryMatch(key: string): { serviceId: ServiceId; canonical: string } | undefined {
  for (const service of SERVICE_REGISTRY) {
    for (const varDef of service.vars) {
      if (varDef.canonical === key || varDef.aliases.includes(key)) {
        return { serviceId: service.id, canonical: varDef.canonical }
      }
    }
  }
  return undefined
}

function candidateStatus(
  values: string[],
  vaultValue: string | undefined,
): ImportCandidate['status'] {
  const distinct = new Set(values)
  if (vaultValue) return distinct.size === 1 && distinct.has(vaultValue) ? 'same' : 'conflict'
  return distinct.size === 1 ? 'new' : 'conflict'
}

export async function scanEnvSources(
  deps: Partial<EnvImportDeps> = {},
): Promise<ImportCandidate[]> {
  const d = withDefaults(deps)
  const files = await collectEnvFiles(join(d.home, 'projetos'), d)

  const vozEnv = join(d.home, '.config', 'voz', 'voz.env')
  const vozStat = d.lstat(vozEnv)
  if (vozStat?.isFile() && !vozStat.isSymbolicLink()) files.push(vozEnv)

  // Ocorrências por chave; o valor fica confinado aqui e vira fingerprint.
  const byKey = new Map<string, { path: string; value: string }[]>()
  for (const path of files) {
    let vars: Record<string, string>
    try {
      vars = parseDotenv(d.readFile(path))
    } catch {
      continue
    }
    for (const [key, value] of Object.entries(vars)) {
      const list = byKey.get(key) ?? []
      byKey.set(key, [...list, { path, value }])
    }
  }

  const vault = d.readCustomEnv()
  return [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, occurrences]) => {
      const match = registryMatch(key)
      let status = candidateStatus(
        occurrences.map((o) => o.value),
        vault[key] || undefined,
      )
      // Alias cuja canônica já está no cofre: importar gravaria uma var que a
      // resolução do serviço (canônica primeiro) nunca leria. Não é "new" cego.
      if (status === 'new' && match && match.canonical !== key && vault[match.canonical]) {
        status = 'shadowed'
      }
      return {
        key,
        ...(match ?? {}),
        sources: occurrences.map(({ path, value }) => ({
          path,
          fingerprint: secretFingerprint(value),
        })),
        status,
      }
    })
}

// O apply revalida o sourcePath com as MESMAS defesas do scan: raiz permitida
// (~/projetos ou o voz.env), nome .env válido, lstat recusando symlink (em cada
// componente do caminho — o scan também não segue symlink de diretório) e cap
// de tamanho. Sem isso, o par (key, sourcePath) vindo do renderer viraria uma
// primitiva de leitura de qualquer arquivo CHAVE=valor (ex.: ~/.aws/credentials)
// exposta depois via reveal.
function isAllowedSource(sourcePath: string, d: EnvImportDeps): boolean {
  const path = normalize(sourcePath)
  const vozEnv = join(d.home, '.config', 'voz', 'voz.env')
  const projRoot = join(d.home, 'projetos') + sep

  if (path !== vozEnv) {
    if (!path.startsWith(projRoot) || !isEnvFile(basename(path))) return false
    // Nenhum diretório intermediário pode ser symlink.
    let cur = projRoot.slice(0, -1)
    const parts = path.slice(projRoot.length).split(sep)
    for (const part of parts.slice(0, -1)) {
      cur = join(cur, part)
      const stDir = d.lstat(cur)
      if (!stDir || !stDir.isDirectory() || stDir.isSymbolicLink()) return false
    }
  }

  const st = d.lstat(path)
  if (!st || !st.isFile() || st.isSymbolicLink()) return false
  return st.size <= MAX_ENV_FILE_BYTES
}

export function applyImport(
  selections: ImportSelection[],
  deps: Partial<EnvImportDeps> = {},
): ApplyImportResult {
  const d = withDefaults(deps)
  const applied: string[] = []
  const missing: string[] = []
  const rejected: string[] = []
  const plaintext = new Set<string>()
  const parsedByPath = new Map<string, Record<string, string>>()

  for (const { key, sourcePath } of selections) {
    if (!isAllowedSource(sourcePath, d)) {
      rejected.push(key)
      continue
    }
    // Ler o caminho normalizado — o mesmo que passou pelo lstat anti-symlink —
    // e não o raw, para não reabrir a janela TOCTOU entre a checagem e a leitura.
    const safePath = normalize(sourcePath)
    let vars = parsedByPath.get(safePath)
    if (!vars) {
      try {
        vars = parseDotenv(d.readFile(safePath))
      } catch {
        vars = {}
      }
      parsedByPath.set(safePath, vars)
    }
    const value = vars[key]
    if (value === undefined) {
      missing.push(key)
      continue
    }
    for (const k of d.setEnvVar(key, value).plaintext) plaintext.add(k)
    applied.push(key)
  }
  return { applied, missing, rejected, plaintext: [...plaintext].sort() }
}
