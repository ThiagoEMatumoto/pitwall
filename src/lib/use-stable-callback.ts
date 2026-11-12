import { useCallback, useRef } from 'react'

// Função com identidade fixa que sempre chama a versão do último render. Serve
// para handler entregue a um filho em memo: a prop não muda, e o filho nunca
// executa uma closure velha. Não use para função chamada durante o render.
export function useStableCallback<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(fn)
  latest.current = fn
  return useCallback((...args: Args) => latest.current(...args), [])
}
