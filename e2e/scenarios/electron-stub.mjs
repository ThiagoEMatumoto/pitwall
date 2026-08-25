// Stub mínimo do módulo `electron` para rodar serviços do main fora do Electron
// (tsx). Só o que o grafo de import da extração toca precisa existir aqui.
export const app = {
  getPath: () => '/tmp/cm-smoke',
  getName: () => 'pitwall',
  isPackaged: false,
}
export const BrowserWindow = { getAllWindows: () => [] }
export const ipcMain = { handle: () => {}, on: () => {} }
export const Notification = class {}
export default { app, BrowserWindow, ipcMain, Notification }
