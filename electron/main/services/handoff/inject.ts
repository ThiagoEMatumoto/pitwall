// Seam de injeção mãe→filha: o único ponto onde o canal de comunicação escreve no
// PTY da sessão-filha. Isolado num módulo fino para que os handlers MCP (tools.ts)
// importem SÓ daqui (não de ipc/sessions.ts, que arrasta electron/ipcMain) e para
// que os testes possam mockar este módulo inteiro.

import { ptyManager } from '../pty-manager'

// Envelopa o comando em bracketed-paste antes de mandar pro PTY. O TUI do claude
// trata o conteúdo entre \x1b[200~ e \x1b[201~ como colagem literal (os \n NÃO
// viram Enter), e só o \r final submete. Defesa pra prompts multi-linha. Esta é a
// fonte canônica; ipc/sessions.ts reexporta daqui (também a usa no kickoff).
export function formatPtyInjection(cmd: string): string {
  return `\x1b[200~${cmd}\x1b[201~\r`
}

// Escreve `text` (já formatado em bracketed-paste) no PTY da sessão-filha. Lança
// se a PTY não está viva (ptyManager.write joga "session not running") — o caller
// (handoff_message) checa isRunning antes e converte num erro legível pra mãe.
export function injectIntoChild(childSessionId: string, text: string): void {
  injectIntoSession(childSessionId, text)
}

// Mesmo seam, sem o rótulo de "filha": a passagem de bastão escreve na MÃE (pra
// avisar que o endereço da filha mudou). O papel muda, o mecanismo é o mesmo — e
// duas funções nomeadas evitam ler `injectIntoChild(motherId, ...)`, que é
// exatamente o tipo de linha que engana quem revisa.
export function injectIntoSession(sessionId: string, text: string): void {
  ptyManager.write(sessionId, formatPtyInjection(text))
}
