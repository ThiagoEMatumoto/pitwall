import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseTuiMenu, type TuiMenu } from '../../../shared/tui/tui-menu-parser'
import {
  forwardKeyNotice,
  routeComposerSend,
  answeredNotice,
  terminalWriteBlockedNotice,
} from './composer-menu-guard'

const screenOf = (name: string): TuiMenu =>
  parseTuiMenu(
    readFileSync(join(__dirname, '../../../shared/tui/__fixtures__', `claude-${name}.txt`), 'utf8'),
  )!

describe('terminalWriteBlockedNotice', () => {
  it('plano aberto: nem Shift+Tab do pill nem /rename chegam ao diálogo', () => {
    const plan = screenOf('2.1.317-plan-auto')
    expect(terminalWriteBlockedNotice(plan, 'permission')).toMatch(/menu aberto/)
    expect(terminalWriteBlockedNotice(plan, 'rename')).toMatch(/não foi pro claude/)
  })

  it('qualquer menu aberto bloqueia; sem menu, escreve', () => {
    expect(
      terminalWriteBlockedNotice(screenOf('2.1.316-permission-bash-curl'), 'rename'),
    ).not.toBeNull()
    expect(terminalWriteBlockedNotice(null, 'permission')).toBeNull()
    expect(terminalWriteBlockedNotice(null, 'rename')).toBeNull()
  })
})

describe('forwardKeyNotice', () => {
  const plan = screenOf('2.1.317-plan-default')

  it('plano aberto: Enter, Tab e Shift+Tab não chegam ao diálogo', () => {
    for (const seq of ['\r', '\t', '\x1b[Z']) {
      expect(forwardKeyNotice(seq, plan, true), JSON.stringify(seq)).not.toBeNull()
    }
  })

  it('Esc descarta só com o composer vazio', () => {
    expect(forwardKeyNotice('\x1b', plan, true)).toBeNull()
    expect(forwardKeyNotice('\x1b', plan, false)).toMatch(/Esc descartaria o plano/)
  })

  it('setas e Ctrl+C seguem; sem plano nada é barrado aqui', () => {
    expect(forwardKeyNotice('\x1b[B', plan, true)).toBeNull()
    expect(forwardKeyNotice('\x03', plan, true)).toBeNull()
    expect(forwardKeyNotice('\x1b[Z', null, false)).toBeNull()
    expect(forwardKeyNotice('\x1b[Z', screenOf('2.1.316-permission-bash-curl'), true)).toBeNull()
  })
})

describe('routeComposerSend — menus da CLI e multi-select (2.1.317)', () => {
  it('nudge do auto mode e submenu do /rewind: bloqueado, aponta o card', () => {
    for (const name of ['2.1.317-auto-mode-env-nudge', '2.1.317-rewind-restore-menu']) {
      const route = routeComposerSend(screenOf(name))
      expect(route.kind, name).toBe('blocked')
      expect(route.kind === 'blocked' && route.notice, name).toMatch(/responda no card acima/)
    }
  })

  it('menus desconhecidos (/hooks, /permissions): bloqueado, aponta o card', () => {
    for (const name of ['2.1.317-unknown-hooks', '2.1.317-unknown-permissions']) {
      const route = routeComposerSend(screenOf(name))
      expect(route.kind === 'blocked' && route.notice, name).toMatch(/responda no card acima/)
    }
  })

  it('AskUserQuestion multi-select: o texto vira o Other (sem enviar)', () => {
    const route = routeComposerSend(screenOf('2.1.317-question-multi-other'))
    expect(route).toEqual({ kind: 'question-other', optionIndex: 3, multi: true })
    expect(answeredNotice({ kind: 'question-other', optionIndex: 3, multi: true })).toMatch(/Envie as respostas pelo card/)
  })

  it('Other que já tem texto no terminal: não recebe mais (vai pro card)', () => {
    const route = routeComposerSend(screenOf('2.1.317-question-multi-other-typed'))
    expect(route.kind === 'blocked' && route.notice).toMatch(/responda no card/)
  })
})
