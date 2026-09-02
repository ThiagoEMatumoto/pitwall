// Short ids for nodes and nonces. Runs in main, in the renderer and in the
// iframe runtime, hence no 'node:crypto' import.

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function randomChars(length: number): string {
  const bytes = new Uint8Array(length)
  const webCrypto = globalThis.crypto
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}

export function newNodeId(): string {
  return randomChars(10)
}

export function newNonce(): string {
  return randomChars(16)
}
