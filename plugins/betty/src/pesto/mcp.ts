export class PestoError extends Error {
  override name = 'PestoError'
}

export type McpSession = {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
}

type Session = { endpoint: string; id: Promise<string | null> }

type JsonRpcMessage = {
  id?: number
  error?: { message?: string }
  result?: {
    isError?: boolean
    content?: { type: string; text?: string }[]
    structuredContent?: unknown
  }
}

const PROTOCOL_VERSION = '2025-06-18'
const SESSION_HEADER = 'Mcp-Session-Id'

class SessionExpired extends Error {}

export function createMcpSession(options: {
  endpoint: () => Promise<string> | string
  getToken: () => Promise<string>
  fetch?: typeof fetch
}): McpSession {
  const fetchFn = options.fetch ?? fetch
  let current: Session | null = null
  let nextId = 1

  async function post(endpoint: string, message: object, session?: { id: string | null }) {
    const token = await options.getToken()
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (session) headers['MCP-Protocol-Version'] = PROTOCOL_VERSION
    if (session?.id) headers[SESSION_HEADER] = session.id
    const response = await fetchFn(endpoint, { method: 'POST', headers, body: JSON.stringify(message) })
    if (response.status === 404 && session?.id) throw new SessionExpired()
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new PestoError(withoutToken(`BETTY answered HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`, token))
    }
    return { response, token }
  }

  async function request(endpoint: string, method: string, params: object, session?: { id: string | null }) {
    const id = nextId++
    const { response, token } = await post(endpoint, { jsonrpc: '2.0', id, method, params }, session)
    const reply = findReply(await response.text(), response.headers.get('content-type'), id)
    if (reply.error) throw new PestoError(withoutToken(reply.error.message || `BETTY refused ${method}`, token))
    return { result: reply.result, token, response }
  }

  async function initialize(endpoint: string): Promise<string | null> {
    const { response } = await request(endpoint, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'bb-plugin-betty', version: '0.1.0' },
    })
    const id = response.headers.get(SESSION_HEADER)
    await post(endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' }, { id })
    return id
  }

  function open(endpoint: string): Session {
    if (current?.endpoint === endpoint) return current
    const session: Session = { endpoint, id: initialize(endpoint) }
    session.id.catch(() => drop(session))
    current = session
    return session
  }

  function drop(session: Session) {
    if (current === session) current = null
  }

  async function callOnce(session: Session, name: string, args: Record<string, unknown>) {
    const { result, token } = await request(session.endpoint, 'tools/call', { name, arguments: args }, { id: await session.id })
    const text = result?.content?.find((item) => item.type === 'text')?.text ?? ''
    if (result?.isError) throw new PestoError(withoutToken(text || `BETTY refused ${name}`, token))
    if (result?.structuredContent !== undefined) return result.structuredContent
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new PestoError(withoutToken(text || `BETTY sent an unreadable answer to ${name}`, token))
    }
  }

  return {
    async callTool(name, args) {
      const session = open(await options.endpoint())
      try {
        return await callOnce(session, name, args)
      } catch (error) {
        if (!(error instanceof SessionExpired)) throw error
        drop(session)
      }
      try {
        return await callOnce(open(session.endpoint), name, args)
      } catch (error) {
        if (error instanceof SessionExpired) throw new PestoError('BETTY forgot the session twice in a row')
        throw error
      }
    },
    async close() {
      const session = current
      if (!session) return
      current = null
      const id = await session.id.catch(() => null)
      if (!id) return
      try {
        const token = await options.getToken()
        await fetchFn(session.endpoint, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}`, 'MCP-Protocol-Version': PROTOCOL_VERSION, [SESSION_HEADER]: id },
        })
      } catch {
        return
      }
    },
  }
}

function findReply(body: string, contentType: string | null, id: number): JsonRpcMessage {
  let messages: JsonRpcMessage[]
  try {
    messages = contentType?.includes('text/event-stream') ? sseMessages(body) : [JSON.parse(body) as JsonRpcMessage]
  } catch {
    throw new PestoError('BETTY sent an answer that is not JSON-RPC')
  }
  const reply = messages.find((message) => message.id === id)
  if (!reply) throw new PestoError('BETTY sent no answer to the request')
  return reply
}

function sseMessages(body: string): JsonRpcMessage[] {
  return body
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n'),
    )
    .filter((data) => data !== '')
    .map((data) => JSON.parse(data) as JsonRpcMessage)
}

function withoutToken(message: string, token: string): string {
  return token ? message.replaceAll(token, '[token]') : message
}
