import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ipc', () => ({
  sendToApi: {
    listRepoFiles: vi.fn(async () => ({
      files: ['src/a12.ts', 'src/session-recorder.ts'],
      truncated: false,
      source: 'git',
    })),
  },
}))

import { useMentionMenu } from './MentionMenu'
import type { SendTarget } from '@/features/quick-composer/target-search'

const recorder = {
  sessionId: 'pty-r',
  ccSessionId: 'cc-r',
  alias: 'session-recorder',
  label: 'session-recorder',
  projectName: null,
  projectColor: null,
  status: 'idle',
  cwd: '/r',
  purpose: null,
} satisfies SendTarget

function menu(text: string, strict: boolean) {
  return renderHook(() =>
    useMentionMenu({ text, caret: text.length, targets: [recorder], cwd: '/r', strict }),
  )
}

describe('useMentionMenu — composer da aba (strict: false)', () => {
  it("'corrige a issue #12' + Enter envia: Enter só escolhe arquivo depois de navegar", async () => {
    const { result } = menu('corrige a issue #12', false)
    await waitFor(() => expect(result.current.files.length).toBeGreaterThan(0))
    expect(result.current.onKey({ key: 'Enter' })).toBeNull()
    act(() => void result.current.onKey({ key: 'ArrowDown' }))
    expect(result.current.onKey({ key: 'Enter' })).toMatchObject({ kind: 'pick' })
  })

  it('Shift+Tab nunca é do menu (cicla o modo de permissão da TUI)', async () => {
    const { result } = menu('#12', false)
    await waitFor(() => expect(result.current.files.length).toBeGreaterThan(0))
    expect(result.current.onKey({ key: 'Tab', shiftKey: true })).toBeNull()
    expect(result.current.onKey({ key: 'Tab' })).toMatchObject({ kind: 'pick' })
  })

  it("'@src' + Enter não troca por uma sessão fuzzy nem trava o envio", () => {
    const { result } = menu('@src', false)
    expect(result.current.sessions.map((s) => s.alias)).toContain('session-recorder')
    expect(result.current.onKey({ key: 'Enter' })).toBeNull()
    expect(menu('@fantasma', false).result.current.onKey({ key: 'Enter' })).toBeNull()
  })
})

describe('useMentionMenu — QuickComposer (strict: true)', () => {
  it('Enter escolhe a primeira sessão; @ sem sessão segura o Enter', () => {
    expect(menu('@sess', true).result.current.onKey({ key: 'Enter' })).toMatchObject({
      kind: 'pick',
      pick: { replacement: '@session-recorder' },
    })
    expect(menu('@fantasma', true).result.current.onKey({ key: 'Enter' })).toEqual({
      kind: 'consumed',
    })
  })
})
