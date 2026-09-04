import { describe, expect, it } from 'vitest'
import { ROW_BAND_PX, orderArtboardsSpatially } from './artboard-order'

interface Board {
  id: string
  x: number
  y: number
  position: number
}

function board(id: string, x: number, y: number, position = 0): Board {
  return { id, x, y, position }
}

function ids(boards: Board[]): string[] {
  return orderArtboardsSpatially(boards).map((b) => b.id)
}

describe('orderArtboardsSpatially', () => {
  it('reads a row left to right, whatever the creation order', () => {
    expect(ids([board('c', 2000, 0, 1), board('a', 0, 0, 3), board('b', 1000, 0, 2)])).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('reads rows top to bottom before left to right', () => {
    const boards = [
      board('b2', 1000, 1200),
      board('a1', 0, 0),
      board('b1', 0, 1200),
      board('a2', 1000, 0),
    ]
    expect(ids(boards)).toEqual(['a1', 'a2', 'b1', 'b2'])
  })

  it('keeps artboards nudged off the row baseline in the same row', () => {
    const boards = [board('right', 900, ROW_BAND_PX), board('left', 0, 0)]
    expect(ids(boards)).toEqual(['left', 'right'])
  })

  it('starts a new row past the band', () => {
    const boards = [board('below', 0, ROW_BAND_PX + 1), board('above', 900, 0)]
    expect(ids(boards)).toEqual(['above', 'below'])
  })

  it('anchors the band on the row start, so a staircase does not merge into one row', () => {
    const boards = [
      board('c', 0, 2 * ROW_BAND_PX),
      board('a', 0, 0),
      board('b', 0, ROW_BAND_PX),
    ]
    expect(ids(boards)).toEqual(['a', 'b', 'c'])
  })

  it('breaks a tie by position, never by identity', () => {
    const boards = [board('second', 100, 100, 7), board('first', 100, 100, 2)]
    expect(ids(boards)).toEqual(['first', 'second'])
  })

  it('does not mutate its input', () => {
    const boards = [board('b', 900, 0), board('a', 0, 0)]
    orderArtboardsSpatially(boards)
    expect(boards.map((b) => b.id)).toEqual(['b', 'a'])
  })

  it('handles an empty document', () => {
    expect(orderArtboardsSpatially([])).toEqual([])
  })
})
