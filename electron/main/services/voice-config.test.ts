import { describe, it, expect, beforeEach, vi } from 'vitest'

// voice-config importa custom-env (pelo redator), cuja cadeia carrega
// 'electron' — mock mínimo pro vitest (node) conseguir coletar o módulo,
// mesmo padrão de custom-env.test.ts.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (plain: string) => Buffer.from(`v:${plain}`, 'utf8'),
    decryptString: (buf: Buffer) => buf.toString('utf8').slice(2),
  },
}))

import {
  parseVozEnv,
  getVoiceConfig,
  resolveSecret,
  voiceSecretRedactor,
  clearVoiceSecrets,
  vozEnvPath,
  type VoiceDeps,
} from './voice-config'

const HOME = '/home/u'
const CONF = `${HOME}/.config/voz/voz.env`

// Deps injetáveis: `files` é o "disco" (path → conteúdo).
function deps(
  over: Partial<VoiceDeps> & { files?: Record<string, string> } = {},
): Partial<VoiceDeps> {
  const { files = {}, ...rest } = over
  return {
    env: {},
    home: HOME,
    exists: (p) => p in files,
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`)
      return files[p]
    },
    exec: vi.fn(async () => ({ stdout: '', stderr: '' })),
    ...rest,
  }
}

beforeEach(() => {
  clearVoiceSecrets()
})

describe('parseVozEnv (porte de config.py:_parse)', () => {
  it('CHAVE=valor simples', () => {
    expect(parseVozEnv('VOZ_STT_URL=https://x/v1')).toEqual({
      VOZ_STT_URL: 'https://x/v1',
    })
  })

  it('corta comentário inline em valor sem aspas', () => {
    expect(parseVozEnv('VOZ_BARRA_MARGEM=220   # explicação')).toEqual({
      VOZ_BARRA_MARGEM: '220',
    })
  })

  it('valor entre aspas é preservado inteiro, inclusive #', () => {
    expect(parseVozEnv('VOZ_STT_PROMPT="Claude Code # jargões"')).toEqual({
      VOZ_STT_PROMPT: 'Claude Code # jargões',
    })
    expect(parseVozEnv("K='a # b'")).toEqual({ K: 'a # b' })
  })

  it('aspas: o que vem depois do fechamento é descartado', () => {
    expect(parseVozEnv('K="abc"  # comentário')).toEqual({ K: 'abc' })
  })

  it('aspa sem fechamento: leva o resto da linha', () => {
    expect(parseVozEnv('K="abc')).toEqual({ K: 'abc' })
  })

  it('aspa no MEIO do valor não conta como valor citado', () => {
    expect(parseVozEnv('K=a"b#c')).toEqual({ K: 'a"b' })
  })

  it('aceita prefixo export', () => {
    expect(parseVozEnv('export VOZ_STT_URL=https://x')).toEqual({
      VOZ_STT_URL: 'https://x',
    })
  })

  it('ignora comentários, linhas vazias e linhas sem =', () => {
    expect(parseVozEnv('# comentário\n\nsó texto\nK=v')).toEqual({ K: 'v' })
  })

  it('ignora chave vazia ou começando com dígito', () => {
    expect(parseVozEnv('=v\n1CHAVE=v\n_OK=v')).toEqual({ _OK: 'v' })
  })

  it('valor vazio vira string vazia', () => {
    expect(parseVozEnv('K=')).toEqual({ K: '' })
  })
})

describe('getVoiceConfig', () => {
  const MINIMAL = 'VOZ_STT_URL=https://proxy.lexter.ai/v1\n'

  it('arquivo ausente → erro PT com o caminho', () => {
    const r = getVoiceConfig(deps())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('Configuração de voz não encontrada')
      expect(r.error).toContain(CONF)
    }
  })

  it('arquivo ausente mas VOZ_STT_URL no ambiente → ok (isolamento de teste/e2e)', () => {
    const r = getVoiceConfig(deps({ env: { VOZ_STT_URL: 'http://127.0.0.1:9' } }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.cfg.sttUrl).toBe('http://127.0.0.1:9')
  })

  it('arquivo sem VOZ_STT_URL → erro PT específico', () => {
    const r = getVoiceConfig(deps({ files: { [CONF]: 'VOZ_TTS_SPEED=1.5\n' } }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('VOZ_STT_URL ausente')
  })

  it('config mínima ganha os padrões do Voz', () => {
    const r = getVoiceConfig(deps({ files: { [CONF]: MINIMAL } }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.cfg).toEqual({
      sttUrl: 'https://proxy.lexter.ai/v1',
      sttModel: 'whisper',
      sttLanguage: 'pt',
      sttPrompt: '',
      sttMinSeconds: 0.4,
      ttsVoice: '33B4UnXyTNbgLmdEDh5P',
      ttsSpeed: 2.0,
      ttsModel: 'eleven_flash_v2_5',
      sttKey: '',
      sttKeyCmd: '',
      ttsKey: '',
      ttsKeyCmd: '',
    })
  })

  it('valores do arquivo sobrescrevem padrões; números são parseados', () => {
    const file = [
      MINIMAL,
      'VOZ_STT_MODELO=whisper-large',
      'VOZ_STT_MIN_SEGUNDOS=1.2  # segundos',
      'VOZ_TTS_SPEED=abc',
      'VOZ_STT_KEY_CMD=gcloud secrets versions access latest --secret=stt',
    ].join('\n')
    const r = getVoiceConfig(deps({ files: { [CONF]: file } }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.cfg.sttModel).toBe('whisper-large')
    expect(r.cfg.sttMinSeconds).toBe(1.2)
    // não-numérico cai no padrão (semântica conf_float)
    expect(r.cfg.ttsSpeed).toBe(2.0)
    expect(r.cfg.sttKeyCmd).toContain('gcloud secrets')
  })

  it('aliases antigos continuam valendo (STT_PROMPT, ELEVENLABS_API_KEY)', () => {
    const file = `${MINIMAL}STT_PROMPT=Claude Code\nELEVENLABS_API_KEY=el-key-1234567890\n`
    const r = getVoiceConfig(deps({ files: { [CONF]: file } }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.cfg.sttPrompt).toBe('Claude Code')
    expect(r.cfg.ttsKey).toBe('el-key-1234567890')
  })

  it('ambiente tem precedência sobre o arquivo', () => {
    const r = getVoiceConfig(
      deps({ files: { [CONF]: MINIMAL }, env: { VOZ_STT_MODELO: 'from-env' } }),
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.cfg.sttModel).toBe('from-env')
  })

  it('XDG_CONFIG_HOME muda o caminho do arquivo', () => {
    expect(vozEnvPath(deps({ env: { XDG_CONFIG_HOME: '/xdg' } }))).toBe('/xdg/voz/voz.env')
    expect(vozEnvPath(deps())).toBe(CONF)
  })
})

describe('resolveSecret', () => {
  it('valor direto no arquivo, sem rodar comando', async () => {
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }))
    const r = await resolveSecret(
      'VOZ_STT_KEY',
      deps({ files: { [CONF]: 'VOZ_STT_KEY=sk-direct-key-123\n' }, exec }),
    )
    expect(r).toEqual({ ok: true, value: 'sk-direct-key-123' })
    expect(exec).not.toHaveBeenCalled()
  })

  it('sem valor direto roda <nome>_CMD e trima o stdout', async () => {
    const exec = vi.fn(async () => ({
      stdout: '  sk-from-vault-456\n',
      stderr: '',
    }))
    const r = await resolveSecret(
      'VOZ_STT_KEY',
      deps({ files: { [CONF]: 'VOZ_STT_KEY_CMD=busca-cofre\n' }, exec }),
    )
    expect(r).toEqual({ ok: true, value: 'sk-from-vault-456' })
    expect(exec).toHaveBeenCalledWith('busca-cofre', expect.anything())
  })

  it('cacheia em memória: segunda chamada não roda o comando de novo', async () => {
    const exec = vi.fn(async () => ({ stdout: 'sk-cached-789\n', stderr: '' }))
    const d = deps({
      files: { [CONF]: 'VOZ_STT_KEY_CMD=busca-cofre\n' },
      exec,
    })
    await resolveSecret('VOZ_STT_KEY', d)
    const r = await resolveSecret('VOZ_STT_KEY', d)
    expect(r).toEqual({ ok: true, value: 'sk-cached-789' })
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('nem valor nem _CMD → erro PT de credencial não configurada', async () => {
    const r = await resolveSecret('VOZ_STT_KEY', deps({ files: { [CONF]: 'K=v\n' } }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('VOZ_STT_KEY não configurada')
  })

  it('comando falha → erro PT com o stderr, sem cachear', async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error('exit 1'), {
        stderr: 'permission denied\n',
      })
    })
    const d = deps({
      files: { [CONF]: 'VOZ_STT_KEY_CMD=busca-cofre\n' },
      exec,
    })
    const r = await resolveSecret('VOZ_STT_KEY', d)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('Falha ao obter a credencial VOZ_STT_KEY')
      expect(r.error).toContain('permission denied')
    }
    await resolveSecret('VOZ_STT_KEY', d)
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('comando sai vazio → erro PT específico', async () => {
    const exec = vi.fn(async () => ({ stdout: '\n', stderr: '' }))
    const r = await resolveSecret(
      'VOZ_STT_KEY',
      deps({ files: { [CONF]: 'VOZ_STT_KEY_CMD=busca-cofre\n' }, exec }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('o comando da credencial saiu vazio')
  })

  it('alias resolve o valor direto (VOZ_TTS_KEY ← ELEVENLABS_API_KEY)', async () => {
    const r = await resolveSecret(
      'VOZ_TTS_KEY',
      deps({ files: { [CONF]: 'ELEVENLABS_API_KEY=el-alias-key-000\n' } }),
    )
    expect(r).toEqual({ ok: true, value: 'el-alias-key-000' })
  })

  it('PATH ganha os diretórios do gcloud que existem no disco', async () => {
    let seenEnv: NodeJS.ProcessEnv = {}
    const exec = vi.fn(async (_cmd: string, env: NodeJS.ProcessEnv) => {
      seenEnv = env
      return { stdout: 'sk\n', stderr: '' }
    })
    const gcloud = `${HOME}/google-cloud-sdk/bin/gcloud`
    await resolveSecret(
      'VOZ_STT_KEY',
      deps({
        files: { [CONF]: 'VOZ_STT_KEY_CMD=busca-cofre\n', [gcloud]: '' },
        env: { PATH: '/usr/bin' },
        exec,
      }),
    )
    expect(seenEnv.PATH).toBe(`${HOME}/google-cloud-sdk/bin:/usr/bin`)
  })
})

describe('voiceSecretRedactor', () => {
  it('redige segredos resolvidos em texto de log', async () => {
    await resolveSecret(
      'VOZ_STT_KEY',
      deps({ files: { [CONF]: 'VOZ_STT_KEY=sk-super-secret-value\n' } }),
    )
    const redact = voiceSecretRedactor()
    expect(redact('auth: sk-super-secret-value fim')).toBe('auth: [REDACTED] fim')
  })

  it('sem segredos resolvidos, texto passa intacto', () => {
    expect(voiceSecretRedactor()('linha qualquer')).toBe('linha qualquer')
  })

  it('clearVoiceSecrets limpa cache e redator', async () => {
    await resolveSecret(
      'VOZ_STT_KEY',
      deps({ files: { [CONF]: 'VOZ_STT_KEY=sk-super-secret-value\n' } }),
    )
    clearVoiceSecrets()
    expect(voiceSecretRedactor()('sk-super-secret-value')).toBe('sk-super-secret-value')
  })
})
