// One Durable Object per channel: the ordered message log and each member's
// delivery cursor. Clients pull everything after their cursor and ack once
// the message is in their session, so a disconnect, a restart or a busy
// session never drops one. The WebSocket carries only wake pings and
// presence; bodies always go over the pull path.
//
// The Worker authenticates every request and names the member in the
// X-Room-Member header; nothing reaches this object any other way.

import { DurableObject } from 'cloudflare:workers'

export type RoomMessage = {
  seq: number
  id: string
  from: string
  to: string | null
  text: string
  sentAt: number
}

// An envelope: the ciphertext plus a wrapped key per recipient device.
const MAX_TEXT = 400_000
const MAX_PULL = 50
// A session (`<login>.<session>`) or a person (`<login>`).
const ADDRESS = /^[a-z0-9][a-z0-9._-]{0,95}$/
const RETAIN_MS = 14 * 24 * 60 * 60 * 1000

type Row = { seq: number; id: string; sender: string; recipient: string | null; text: string; sent_at: number }

export class Room extends DurableObject<Env> {
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        sender TEXT NOT NULL,
        recipient TEXT,
        text TEXT NOT NULL,
        sent_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cursors (
        member TEXT PRIMARY KEY,
        cursor INTEGER NOT NULL
      );
    `)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const member = request.headers.get('X-Room-Member') ?? ''

    switch (`${request.method} ${url.pathname}`) {
      case 'GET /ws':
        return this.openSocket(request, member)
      case 'POST /messages':
        return this.post(member, await request.json())
      case 'GET /messages':
        return this.pull(member)
      case 'POST /ack':
        return this.ack(member, await request.json())
      case 'GET /presence':
        return json({ online: this.online() })
      case 'GET /history':
        return this.history(Number(url.searchParams.get('limit') ?? 30))
      // The channel's settings changed (it became encrypted): sessions re-read them.
      case 'POST /notify':
        this.broadcast({ type: 'settings' })
        return json({ ok: true })
      // Drops the message history; delivery cursors stay.
      case 'POST /purge':
        this.sql.exec(`DELETE FROM messages`)
        return json({ ok: true })
      case 'POST /destroy':
        for (const ws of this.ctx.getWebSockets()) ws.close(4000, 'channel deleted')
        await this.ctx.storage.deleteAll()
        return json({ ok: true })
      // A session connected under this name: start its cursor now (a
      // reconnect keeps the one it had) and close any earlier socket.
      case 'POST /register':
        return json({ cursor: this.cursorOf(member), closed: this.close(member, 4002, 'replaced by a new session') })
      // A session without a device key in a channel that just became encrypted:
      // close its socket until it registers one. Its cursor stays.
      case 'POST /require-device':
        return json({ closed: this.close(member, 4003, 'device key required') })
      // The name was disconnected or its owner removed: forget it.
      case 'POST /forget':
        this.sql.exec(`DELETE FROM cursors WHERE member = ?`, member)
        return json({ closed: this.close(member, 4001, 'disconnected') })
      default:
        return json({ error: 'not found' }, 404)
    }
  }

  // A member seen for the first time starts at the head: no history from
  // before it joined.
  private cursorOf(member: string): number {
    this.sql.exec(
      `INSERT INTO cursors (member, cursor) VALUES (?, COALESCE((SELECT MAX(seq) FROM messages), 0))
       ON CONFLICT(member) DO NOTHING`,
      member,
    )
    return this.sql.exec<{ cursor: number }>(`SELECT cursor FROM cursors WHERE member = ?`, member).one().cursor
  }

  private openSocket(request: Request, member: string): Response {
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426)
    this.cursorOf(member)

    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server, [member])
    server.send(JSON.stringify({ type: 'wake' }))
    this.broadcast({ type: 'presence', online: this.online() })

    const protocol = request.headers.get('Sec-WebSocket-Protocol')?.split(',')[0]?.trim()
    return new Response(null, { status: 101, webSocket: client, headers: protocol ? { 'Sec-WebSocket-Protocol': protocol } : {} })
  }

  private post(member: string, body: unknown): Response {
    const { id, to, text } = (body ?? {}) as { id?: unknown; to?: unknown; text?: unknown }
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) return json({ error: 'id required' }, 400)
    if (typeof text !== 'string' || text.trim().length === 0) return json({ error: 'text required' }, 400)
    if (text.length > MAX_TEXT) return json({ error: `text over ${MAX_TEXT} characters` }, 413)
    if (to !== undefined && to !== null && (typeof to !== 'string' || !ADDRESS.test(to))) return json({ error: 'bad recipient address' }, 400)
    this.cursorOf(member)

    // The id makes a retried POST idempotent.
    const existing = this.sql.exec<{ seq: number }>(`SELECT seq FROM messages WHERE id = ?`, id).toArray()[0]
    if (existing) return json({ seq: existing.seq, isDuplicate: true })

    const seq = this.sql
      .exec<{ seq: number }>(
        `INSERT INTO messages (id, sender, recipient, text, sent_at) VALUES (?, ?, ?, ?, ?) RETURNING seq`,
        id,
        member,
        (to as string | null | undefined) ?? null,
        text,
        Date.now(),
      )
      .one().seq

    this.broadcast({ type: 'wake' }, member)
    this.prune()
    return json({ seq })
  }

  // Everything after the cursor addressed to everyone, to this session, or to
  // the person it belongs to (all their sessions get it); never its own.
  private pull(member: string): Response {
    const cursor = this.cursorOf(member)
    const person = member.includes('.') ? member.slice(0, member.indexOf('.')) : member
    const messages = this.sql
      .exec<Row>(
        `SELECT * FROM messages
         WHERE seq > ? AND sender != ? AND (recipient IS NULL OR recipient = ? OR recipient = ?)
         ORDER BY seq LIMIT ?`,
        cursor,
        member,
        member,
        person,
        MAX_PULL,
      )
      .toArray()
      .map(toMessage)
    return json({ cursor, messages })
  }

  private ack(member: string, body: unknown): Response {
    const { seq } = (body ?? {}) as { seq?: unknown }
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return json({ error: 'seq required' }, 400)
    this.cursorOf(member)
    this.sql.exec(`UPDATE cursors SET cursor = MAX(cursor, ?) WHERE member = ?`, seq, member)
    return json({ cursor: this.cursorOf(member) })
  }

  private history(limit: number): Response {
    const rows = this.sql
      .exec<Row>(`SELECT * FROM messages ORDER BY seq DESC LIMIT ?`, Math.min(Math.max(1, limit), 200))
      .toArray()
      .reverse()
    return json({ messages: rows.map(toMessage) })
  }

  private close(member: string, code: number, reason: string): number {
    const sockets = this.ctx.getWebSockets(member)
    for (const ws of sockets) ws.close(code, reason)
    if (sockets.length > 0) this.broadcast({ type: 'presence', online: this.online() })
    return sockets.length
  }

  private online(): string[] {
    return [...new Set(this.ctx.getWebSockets().flatMap(ws => this.ctx.getTags(ws)))].sort()
  }

  private broadcast(event: object, except?: string) {
    const text = JSON.stringify(event)
    for (const ws of this.ctx.getWebSockets()) {
      if (except !== undefined && this.ctx.getTags(ws).includes(except)) continue
      try {
        ws.send(text)
      } catch {
        // Mid-close; that client re-pulls when it reconnects.
      }
    }
  }

  // Keep history for the web UI and read_messages: drop only past retention.
  private prune() {
    this.sql.exec(`DELETE FROM messages WHERE sent_at < ?`, Date.now() - RETAIN_MS)
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === 'ping') ws.send('pong')
  }

  webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code)
    } catch {
      // Already closed.
    }
    this.broadcast({ type: 'presence', online: this.online() })
  }
}

function toMessage(row: Row): RoomMessage {
  return { seq: row.seq, id: row.id, from: row.sender, to: row.recipient, text: row.text, sentAt: row.sent_at }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
