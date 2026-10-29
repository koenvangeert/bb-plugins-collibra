import { readFileSync } from 'node:fs'

export const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')

export type RecordedRequest = {
  url: string
  method: string
  headers: Record<string, string>
  body: { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } | null
}

type ToolReply = { text: string; isError?: boolean } | { rpcError: string }

export function createFakePesto(options: {
  tools?: Record<string, ToolReply | ((args: Record<string, unknown>) => ToolReply)>
  sse?: boolean
}) {
  const requests: RecordedRequest[] = []
  const expiredSessions = new Set<string>()
  const failNextToolCallsWith404 = { count: 0 }
  let sessions = 0

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => (headers[key] = value))
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    const request: RecordedRequest = { url: String(input), method: init?.method ?? 'GET', headers, body }
    requests.push(request)
    await Promise.resolve()

    const sessionId = headers['mcp-session-id']
    if (request.method === 'DELETE') return new Response(null, { status: 204 })
    if (body?.method === 'initialize') {
      sessions += 1
      return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }, {
        'Mcp-Session-Id': `session-${sessions}`,
      })
    }
    if (sessionId === undefined || expiredSessions.has(sessionId)) return new Response('unknown session', { status: 404 })
    if (body?.method === 'notifications/initialized') return new Response(null, { status: 202 })
    if (body?.method === 'tools/call') {
      if (failNextToolCallsWith404.count > 0) {
        failNextToolCallsWith404.count -= 1
        expiredSessions.add(sessionId)
        return new Response('unknown session', { status: 404 })
      }
      const tool = options.tools?.[body.params?.name ?? '']
      const reply = typeof tool === 'function' ? tool(body.params?.arguments ?? {}) : tool
      if (reply === undefined) return json({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'unknown tool' } })
      const message =
        'rpcError' in reply
          ? { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: reply.rpcError } }
          : { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: reply.text }], isError: reply.isError } }
      return options.sse ? sse(message) : json(message)
    }
    return new Response('bad request', { status: 400 })
  }

  return {
    fetch,
    requests,
    toolCalls: () => requests.filter((request) => request.body?.method === 'tools/call'),
    initializes: () => requests.filter((request) => request.body?.method === 'initialize'),
    expireSessionOnNextToolCalls: (count: number) => {
      failNextToolCallsWith404.count = count
    },
  }
}

function json(message: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
}

function sse(message: unknown) {
  const ping = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`
  return new Response(`${ping}event: message\ndata: ${JSON.stringify(message)}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}
