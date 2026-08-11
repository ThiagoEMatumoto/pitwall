/** @vitest-environment node */
// Unit do transporte da identidade da sessão-mãe (módulo puro): o que o app
// escreve no mcp-config e o que o servidor consegue ler de volta.
import { describe, expect, it } from 'vitest'
import {
  MCP_SESSION_HEADER,
  MCP_SESSION_QUERY_PARAM,
  buildSessionEndpoint,
  readMotherSessionId,
} from './session-identity'

const BASE = { url: 'http://127.0.0.1:41956/mcp', token: 'tok' }
const SESSION_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

describe('buildSessionEndpoint', () => {
  it('sem sessionId devolve o endpoint global, sem query', () => {
    const { url, headers } = buildSessionEndpoint(BASE, null)
    expect(url).toBe(BASE.url)
    expect(headers.Authorization).toBe('Bearer tok')
  })

  it('com sessionId acrescenta ?s=<id> preservando path e porta', () => {
    const { url, headers } = buildSessionEndpoint(BASE, SESSION_ID)
    const parsed = new URL(url)
    expect(parsed.pathname).toBe('/mcp')
    expect(parsed.port).toBe('41956')
    expect(parsed.searchParams.get(MCP_SESSION_QUERY_PARAM)).toBe(SESSION_ID)
    // O token continua sendo credencial de header — identidade não é credencial.
    expect(headers.Authorization).toBe('Bearer tok')
  })
})

describe('readMotherSessionId', () => {
  const url = (raw: string) => new URL(raw, 'http://127.0.0.1')

  it('lê o uuid da query string', () => {
    expect(readMotherSessionId({ url: url(`/mcp?s=${SESSION_ID}`) })).toBe(SESSION_ID)
  })

  it('sem o parâmetro devolve null (config global legada)', () => {
    expect(readMotherSessionId({ url: url('/mcp') })).toBeNull()
  })

  it('rejeita valor que não é uuid (nada de id inventado no banco)', () => {
    expect(readMotherSessionId({ url: url('/mcp?s=nao-e-uuid') })).toBeNull()
    expect(readMotherSessionId({ url: url('/mcp?s=') })).toBeNull()
    expect(readMotherSessionId({ url: url('/mcp?s=../../etc/passwd') })).toBeNull()
  })

  // Caminho de FALLBACK já ligado do lado servidor: se a query string não
  // sobreviver da CLI, basta o cliente passar a mandar o header.
  it('aceita o header X-CM-Session-Id como fallback', () => {
    expect(readMotherSessionId({ url: url('/mcp'), headers: { [MCP_SESSION_HEADER]: SESSION_ID } }))
      .toBe(SESSION_ID)
    expect(
      readMotherSessionId({ url: url('/mcp'), headers: { [MCP_SESSION_HEADER]: 'lixo' } }),
    ).toBeNull()
  })

  it('a query vence o header quando ambos vêm', () => {
    const other = '11111111-2222-3333-4444-555555555555'
    expect(
      readMotherSessionId({
        url: url(`/mcp?s=${SESSION_ID}`),
        headers: { [MCP_SESSION_HEADER]: other },
      }),
    ).toBe(SESSION_ID)
  })
})
