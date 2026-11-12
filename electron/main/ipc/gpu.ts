import { app, ipcMain } from 'electron'
import { z } from 'zod'
import { getPref, setPref } from '../services/prefs-store'
import {
  getGpuState,
  parseGpuAutoDisabled,
  GPU_AUTO_PREF_KEY,
  GPU_DISABLED_BY_USER_PREF_KEY,
  GPU_DISABLED_PREF_KEY,
  OZONE_PREF_KEY,
  OZONE_PREF_DEFAULT,
} from '../services/gpu-state'
import type { GpuStatus } from '../../../shared/types/ipc'

const boolSchema = z.boolean()

export function registerGpuIpc(): void {
  // Estado EM VIGOR (decidido no boot, imutável no processo) + prefs atuais.
  // A UI usa a divergência entre os dois pra mostrar "requer reiniciar".
  ipcMain.handle('gpu:status', (): GpuStatus => {
    const state = getGpuState()
    return {
      hwAccelDisabled: state.hwAccelDisabled,
      ozoneWayland: state.ozoneWayland,
      prefDisabled: getPref(GPU_DISABLED_PREF_KEY, false),
      prefOzone: getPref(OZONE_PREF_KEY, OZONE_PREF_DEFAULT),
      autoDisabled: parseGpuAutoDisabled(getPref<unknown>(GPU_AUTO_PREF_KEY, null)),
    }
  })

  // A marca separa esta escolha do gpu.disabled=true que o automático antigo
  // gravava: só o que não tem marca entra na re-tentativa do boot. Religar pela
  // UI também encerra o desligamento automático pendente.
  //
  // A ordem das escritas nunca deixa gpu.disabled=true sem a marca, nem se uma
  // delas falhar: ao desligar a marca entra antes, ao religar ela sai depois.
  // Esse estado é o que o boot lê como legado, e ele religaria a GPU em teste.
  ipcMain.handle('gpu:set-disabled', (_e, payload: unknown) => {
    const disabled = boolSchema.parse(payload)
    if (disabled) {
      setPref(GPU_DISABLED_BY_USER_PREF_KEY, true)
      setPref(GPU_DISABLED_PREF_KEY, true)
      return
    }
    setPref(GPU_DISABLED_PREF_KEY, false)
    setPref(GPU_DISABLED_BY_USER_PREF_KEY, false)
    setPref(GPU_AUTO_PREF_KEY, null)
  })

  ipcMain.handle('gpu:set-ozone', (_e, payload: unknown) => {
    setPref(OZONE_PREF_KEY, boolSchema.parse(payload))
  })

  // Reinicia o app pra aplicar mudanças de GPU (decididas antes do ready). O
  // quit dispara o before-quit existente (flush de sync + shutdown limpo).
  ipcMain.handle('app:relaunch', () => {
    app.relaunch()
    app.quit()
  })
}
