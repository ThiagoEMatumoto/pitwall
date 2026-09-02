// Ações compartilhadas por tray e atalho global: iniciar mostra a janela
// flutuante junto; toggle decide pelo estado atual do gravador.
import { floatingRegistry, getRecorder } from './recorder-contract'

export async function startRecording(): Promise<void> {
  await getRecorder().start({})
  floatingRegistry.current?.('show')
}

export async function stopRecording(): Promise<void> {
  await getRecorder().stop()
}

export async function toggleRecording(): Promise<void> {
  if (getRecorder().getState().active) await stopRecording()
  else await startRecording()
}
