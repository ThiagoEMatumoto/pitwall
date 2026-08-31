// Loader ESM que resolve `electron` para um stub cujo app.getPath('userData')
// aponta pro diretorio em CM_USERDATA. Permite exercitar servicos do main
// (db.ts, feature-store, loop-snapshot) contra um banco real fora do Electron.
const USERDATA = process.env.CM_USERDATA ?? '/tmp'

const STUB = `
export const app = {
  getPath: () => ${JSON.stringify(USERDATA)},
  getName: () => 'pitwall',
  getVersion: () => '0.0.0-probe',
  isPackaged: false,
}
export const BrowserWindow = { getAllWindows: () => [] }
export const ipcMain = { handle: () => {}, on: () => {} }
export const Notification = class {}
export default { app, BrowserWindow, ipcMain, Notification }
`

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: 'cm-userdata-stub:electron', shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url === 'cm-userdata-stub:electron') {
    return { format: 'module', source: STUB, shortCircuit: true }
  }
  return nextLoad(url, context)
}
