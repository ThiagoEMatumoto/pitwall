// Carrega o addon N-API do sherpa-onnx sem nunca lançar: quem chama decide o
// que fazer com `null` (diarização 'unavailable', gravação segue). Serve tanto
// ao processo main quanto ao diarizer-worker (utilityProcess), por isso não
// importa `electron` — o path unpacked é deduzido do próprio `app.asar`.
/// <reference path="./sherpa-onnx-node.d.ts" />
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { arch, platform } from 'node:os'

export type SherpaModule = typeof import('sherpa-onnx-node')

const require = createRequire(import.meta.url)

let cached: SherpaModule | null | undefined
let loadError: string | null = null

function binaryPackage(): string {
  const os = platform() === 'win32' ? 'win' : platform()
  return `sherpa-onnx-${os}-${arch()}`
}

// electron-builder mantém os pacotes dentro do asar e copia para
// app.asar.unpacked (asarUnpack); o .node e as .so só carregam do lado unpacked.
function unpacked(p: string): string {
  return p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
}

/** Dir real do binário (`sherpa-onnx.node` + `.so`), ou null se o pacote não está instalado. */
export function sherpaBinaryDir(): string | null {
  try {
    const dir = unpacked(dirname(require.resolve(`${binaryPackage()}/package.json`)))
    return existsSync(join(dir, 'sherpa-onnx.node')) ? dir : null
  } catch {
    return null
  }
}

export function loadSherpa(): SherpaModule | null {
  if (cached !== undefined) return cached
  const binDir = sherpaBinaryDir()
  if (!binDir) {
    loadError = `pacote ${binaryPackage()} não instalado (diarização só no Linux x64 nesta versão)`
    cached = null
    return null
  }
  // RUNPATH=$ORIGIN já resolve as .so ao lado do .node; o LD_LIBRARY_PATH é
  // redundância barata para builds que percam o RUNPATH.
  const current = process.env.LD_LIBRARY_PATH
  if (!current?.split(':').includes(binDir)) {
    process.env.LD_LIBRARY_PATH = current ? `${binDir}:${current}` : binDir
  }
  try {
    cached = require('sherpa-onnx-node') as SherpaModule
    loadError = null
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err)
    cached = null
  }
  return cached
}

export function sherpaAvailable(): boolean {
  return loadSherpa() !== null
}

export function sherpaLoadError(): string | null {
  loadSherpa()
  return loadError
}

/** Só para testes: esquece o resultado cacheado. */
export function resetSherpaCache(): void {
  cached = undefined
  loadError = null
}
