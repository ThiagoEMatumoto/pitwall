import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// HTTP client for the app's MCP server, the same path a Claude session uses.
// Reads url + token from the mcp.json the app writes into the (copied) userData.

export interface McpContent {
  type: string
  text?: string
  data?: string
  mimeType?: string
}

export interface McpRawResult {
  content?: McpContent[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export interface McpClient {
  url: string
  // Parsed JSON of the first text block (what `ok()` tools return).
  call<T = any>(name: string, args?: Record<string, unknown>): Promise<T>
  // Full result, for tools that return image blocks (design_screenshot).
  callRaw(name: string, args?: Record<string, unknown>): Promise<McpRawResult>
}

function parseBody(text: string): any {
  // StreamableHTTP may answer as SSE ("data: {...}") or plain JSON.
  const jsonLine =
    text.startsWith('event:') || text.includes('\ndata: ')
      ? text
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6))
          .join('')
      : text
  return JSON.parse(jsonLine)
}

export async function connectMcp(userDataCopy: string): Promise<McpClient> {
  const cfg = JSON.parse(readFileSync(join(userDataCopy, 'mcp.json'), 'utf8'))
  const url: string = cfg.url
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${cfg.token}`,
  }
  let rpcId = 0

  async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    })
    return parseBody(await res.text())
  }

  // Stateless server: every request builds a fresh server, but the protocol asks for it.
  await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '0' },
  })

  async function callRaw(name: string, args: Record<string, unknown> = {}): Promise<McpRawResult> {
    const parsed = await rpc('tools/call', { name, arguments: args })
    if (parsed.error) throw new Error(`${name}: rpc error ${JSON.stringify(parsed.error)}`)
    const result: McpRawResult = parsed.result
    if (result?.isError) {
      throw new Error(`${name}: tool error ${result.content?.[0]?.text ?? ''}`)
    }
    return result
  }

  async function call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await callRaw(name, args)
    const text = result.content?.find((c) => c.type === 'text')?.text
    if (text) {
      try {
        return JSON.parse(text) as T
      } catch {
        return text as unknown as T
      }
    }
    return (result.structuredContent ?? result) as T
  }

  return { url, call, callRaw }
}
