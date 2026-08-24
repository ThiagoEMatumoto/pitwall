import { describe, expect, it } from 'vitest'
import { insertDictation } from './composer-insert'

describe('insertDictation', () => {
  it('inserts into an empty draft without a leading separator', () => {
    expect(insertDictation('', 'olá mundo', 0, 0)).toEqual({
      value: 'olá mundo',
      cursor: 9,
    })
  })

  it('appends at the end (textarea without focus) with a space separator', () => {
    const res = insertDictation('já digitado', 'e ditado', 11, 11)
    expect(res.value).toBe('já digitado e ditado')
    expect(res.cursor).toBe(res.value.length)
  })

  it('inserts at the cursor in the middle, separating from the text before it', () => {
    const value = 'antes depois'
    const res = insertDictation(value, 'ditado', 5, 5)
    expect(res.value).toBe('antes ditado depois')
    expect(res.cursor).toBe('antes ditado'.length)
  })

  it('skips the separator when the text before the cursor already ends in whitespace', () => {
    expect(insertDictation('linha um\n', 'linha dois', 9, 9).value).toBe('linha um\nlinha dois')
    expect(insertDictation('com espaço ', 'ditado', 11, 11).value).toBe('com espaço ditado')
  })

  it('replaces the selected range with the dictation', () => {
    const res = insertDictation('troque ISTO aqui', 'aquilo', 7, 11)
    expect(res.value).toBe('troque aquilo aqui')
    expect(res.cursor).toBe('troque aquilo'.length)
  })
})
