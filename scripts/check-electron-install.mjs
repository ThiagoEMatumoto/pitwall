// O instalador do Electron pode terminar com exit 0 sem ter extraído o binário:
// o `extract-zip` monta `fd-slicer -> inflateRaw`, e sob Node 24.16/24.17 o
// stream não retoma depois do backpressure — a promise nunca resolve, o event
// loop esvazia e o processo sai limpo com o `dist/` pela metade. O sintoma só
// aparece depois, ao rodar o app ou a suíte, como "Electron failed to install
// correctly".
//
// A regressão foi corrigida no Node 24.18.1 (ver .nvmrc), mas a classe do
// problema — postinstall que falha em silêncio — volta a cada upgrade de
// toolchain. Este guard troca isso por um erro alto, na hora do install.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Peso mínimo do executável. Não vale no macOS: lá o path.txt aponta pro binário
// DENTRO do .app, pequeno de propósito — o peso está no Electron Framework.
const MIN_BINARY_BYTES = 50_000_000

// Retorna null quando está tudo certo (ou quando não há Electron a verificar),
// ou a razão da falha. `deps` existe para o teste não precisar de um node_modules
// de verdade.
export function checkElectronInstall(root, platform = process.platform, deps = {}) {
  const exists = deps.existsSync ?? existsSync
  const read = deps.readFileSync ?? readFileSync
  const stat = deps.statSync ?? statSync

  const electronDir = join(root, 'node_modules', 'electron')
  // Install sem devDependencies (imagem slim, CI de produção): nada a verificar.
  if (!exists(electronDir)) return null

  const pathTxt = join(electronDir, 'path.txt')
  if (!exists(pathTxt)) return 'node_modules/electron/path.txt não existe'

  const dist = join(electronDir, 'dist')
  const binary = join(dist, read(pathTxt, 'utf8').trim())
  if (!exists(binary)) return `o binário não foi extraído: ${binary}`

  // `version` é o último sinal de que o pacote inteiro chegou ao disco: uma
  // extração truncada deixa um punhado de entradas arbitrárias, quase nunca essa.
  if (!exists(join(dist, 'version'))) return `dist/version não existe em ${dist}`

  if (platform !== 'darwin') {
    const { size } = stat(binary)
    if (size < MIN_BINARY_BYTES) return `o binário está truncado (${size} bytes): ${binary}`
  }
  return null
}

// A regressão de streams vive nesta janela; fora dela a dica seria enganosa.
export function isAffectedNode(version) {
  const [major, minor] = version.split('.').map(Number)
  return major === 24 && minor >= 16 && minor < 18
}

export function formatFailure(reason, nodeVersion) {
  return [
    '',
    `✗ A instalação do Electron não completou — ${reason}.`,
    '',
    `  Node em uso: v${nodeVersion}`,
    isAffectedNode(nodeVersion)
      ? '  Esta versão do Node tem a regressão de streams que faz a extração parar\n    no meio SEM erro. Use a versão do .nvmrc (`fnm use`) e reinstale.'
      : '  Rode `node node_modules/electron/install.js` e verifique se o binário aparece.',
    '',
  ].join('\n')
}

// Só executa a checagem quando chamado como script (o postinstall), não no import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const reason = checkElectronInstall(join(dirname(fileURLToPath(import.meta.url)), '..'))
  if (reason) {
    console.error(formatFailure(reason, process.versions.node))
    process.exit(1)
  }
}
