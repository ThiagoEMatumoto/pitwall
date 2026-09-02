import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotesEditor } from './NotesEditor'

const BASE = 'Pauta inicial'
const QUICK = `${BASE}\n- [00:12] Nota rápida pela flutuante`
const PLACEHOLDER = 'Suas anotações durante a reunião…'

describe('NotesEditor', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('adota o texto do servidor quando não há edição local', () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(<NotesEditor meetingId="m1" initial={BASE} onSave={onSave} />)

    rerender(<NotesEditor meetingId="m1" initial={QUICK} onSave={onSave} />)

    expect(screen.getByPlaceholderText(PLACEHOLDER)).toHaveValue(QUICK)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('anexa a nota rápida ao texto local sujo e salva os dois', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(<NotesEditor meetingId="m1" initial={BASE} onSave={onSave} />)
    const textarea = screen.getByPlaceholderText(PLACEHOLDER)
    const local = `${BASE}\nDecidimos migrar o banco`
    fireEvent.change(textarea, { target: { value: local } })

    rerender(<NotesEditor meetingId="m1" initial={QUICK} onSave={onSave} />)

    const merged = `${local}\n- [00:12] Nota rápida pela flutuante`
    expect(textarea).toHaveValue(merged)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith('m1', merged)
    expect(screen.getByText('Salvo')).toBeInTheDocument()
  })

  it('mantém o texto local quando o servidor divergiu de verdade', () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(<NotesEditor meetingId="m1" initial={BASE} onSave={onSave} />)
    const textarea = screen.getByPlaceholderText(PLACEHOLDER)
    const local = `${BASE}\nMinha edição`
    fireEvent.change(textarea, { target: { value: local } })

    rerender(<NotesEditor meetingId="m1" initial="Outra base qualquer" onSave={onSave} />)

    expect(textarea).toHaveValue(local)
  })

  it('não reanexa o que o próprio editor acabou de salvar', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(<NotesEditor meetingId="m1" initial={BASE} onSave={onSave} />)
    const textarea = screen.getByPlaceholderText(PLACEHOLDER)
    const local = `${BASE}\nMinha edição`
    fireEvent.change(textarea, { target: { value: local } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(onSave).toHaveBeenCalledWith('m1', local)

    // O store devolve o que foi salvo: nada muda.
    rerender(<NotesEditor meetingId="m1" initial={local} onSave={onSave} />)
    expect(textarea).toHaveValue(local)
  })

  it('não trata o eco do próprio save como mudança externa (regressão: nota duplicada)', async () => {
    let resolveSave!: () => void
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve
        }),
    )
    const { rerender } = render(<NotesEditor meetingId="m1" initial={BASE} onSave={onSave} />)
    const textarea = screen.getByPlaceholderText(PLACEHOLDER)
    const local = `${BASE}\nMinha edição`
    fireEvent.change(textarea, { target: { value: local } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith('m1', local)
    expect(screen.getByText('Salvando…')).toBeInTheDocument()

    // O broadcast do store re-renderiza com o texto enviado ANTES do onSave resolver.
    rerender(<NotesEditor meetingId="m1" initial={local} onSave={onSave} />)
    expect(textarea).toHaveValue(local)

    await act(async () => {
      resolveSave()
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(textarea).toHaveValue(local)
    expect(screen.getByText('Salvo')).toBeInTheDocument()
  })
})
