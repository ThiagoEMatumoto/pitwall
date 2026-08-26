// Só o que este módulo usa do xterm — assim o registro aceita dublês em teste
// (o renderer WebGL real não roda em jsdom).
export interface AtlasTerminal {
  rows: number
  clearTextureAtlas(): void
  refresh(start: number, end: number): void
}

// O TextureAtlas do addon-webgl é COMPARTILHADO entre terminais com a mesma
// fonte/tamanho/tema/dpr (addon-webgl/CharAtlasCache: acquireTextureAtlas devolve
// a mesma instância e só faz push em `ownedBy`). Mas Terminal.clearTextureAtlas()
// limpa a textura de todos e só refaz o model + repinta de QUEM chamou — os
// vizinhos seguem com o model apontando pra coordenadas de textura invalidadas e
// desenham glifos trocados/borrados. Daí o registro global: limpar o atlas exige
// repintar todo mundo que o compartilha.
const live = new Set<AtlasTerminal>()

export function registerTerminal(term: AtlasTerminal): () => void {
  live.add(term)
  return () => {
    live.delete(term)
  }
}

export function clearSharedAtlas(): void {
  for (const term of live) {
    term.clearTextureAtlas()
    term.refresh(0, term.rows - 1)
  }
}
