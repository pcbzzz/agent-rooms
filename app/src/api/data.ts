// Every channel operation, shared by the web API and the MCP tools so both
// enforce the same rules. Each takes the acting user's id.

import type { RoomMessage } from '../room'

export class UserError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409,
    message: string,
  ) {
    super(message)
  }
}

export type User = { id: string; login: string; name: string | null; avatar_url: string | null }
export type Channel = { id: string; name: string; owner_id: string; created_at: number; role: 'owner' | 'member' }

const CHANNEL_NAME = /^[\w .'-]{1,48}$/u
const SESSION = /^[a-z0-9][a-z0-9-]{0,39}$/
const CLAIM_TTL_MS = 10 * 60 * 1000

export const now = () => Date.now()

export function randomId(bytes = 12): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function room(env: Env, channelId: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(channelId))
}

export async function roomCall<T>(env: Env, channelId: string, path: string, init: RequestInit & { member?: string } = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.member) headers.set('X-Room-Member', init.member)
  const res = await room(env, channelId).fetch(`https://room${path}`, { ...init, headers })
  const body = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new UserError(400, body.error ?? `room error ${res.status}`)
  return body
}

// --- users -----------------------------------------------------------------

export async function upsertGithubUser(env: Env, gh: { id: number; login: string; name?: string | null; avatar_url?: string | null }): Promise<User> {
  const login = gh.login.toLowerCase()
  const existing = await env.DB.prepare(`SELECT id FROM users WHERE github_id = ? OR (github_id IS NULL AND login = ?)`)
    .bind(gh.id, login)
    .first<{ id: string }>()
  const id = existing?.id ?? randomId()
  await env.DB.prepare(
    `INSERT INTO users (id, github_id, login, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET github_id = excluded.github_id, login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url`,
  )
    .bind(id, gh.id, login, gh.name ?? null, gh.avatar_url ?? null, now())
    .run()
  return (await getUser(env, id))!
}

export function getUser(env: Env, id: string) {
  return env.DB.prepare(`SELECT id, login, name, avatar_url FROM users WHERE id = ?`).bind(id).first<User>()
}

// A user added by GitHub username before they ever signed in gets a row
// holding just that login, which their first GitHub sign-in then claims.
// GitHub's API is asked only to catch typos; it often rate-limits Workers.
async function userByLogin(env: Env, login: string): Promise<User> {
  const clean = login.replace(/^@/, '').toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(clean)) throw new UserError(400, `${login} is not a GitHub username.`)
  const found = await env.DB.prepare(`SELECT id, login, name, avatar_url FROM users WHERE login = ?`).bind(clean).first<User>()
  if (found) return found
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(clean)}`, {
    headers: { 'User-Agent': 'agent-rooms', Accept: 'application/vnd.github+json' },
  }).catch(() => undefined)
  if (res?.status === 404) throw new UserError(404, `No GitHub user ${clean}.`)
  if (res?.ok) return upsertGithubUser(env, (await res.json()) as { id: number; login: string; name: string | null; avatar_url: string })
  const id = randomId()
  await env.DB.prepare(`INSERT INTO users (id, github_id, login, name, avatar_url, created_at) VALUES (?, NULL, ?, NULL, NULL, ?)`).bind(id, clean, now()).run()
  return (await getUser(env, id))!
}

// --- channels ----------------------------------------------------------------

export function listChannels(env: Env, userId: string) {
  return env.DB.prepare(
    `SELECT c.id, c.name, c.owner_id, c.created_at, m.role,
            (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) AS member_count,
            (SELECT COUNT(*) FROM connections WHERE channel_id = c.id AND token_hash IS NOT NULL) AS connection_count
     FROM channels c JOIN channel_members m ON m.channel_id = c.id AND m.user_id = ?
     ORDER BY c.created_at DESC`,
  )
    .bind(userId)
    .all<Channel & { member_count: number; connection_count: number }>()
    .then(r => r.results)
}

// Resolves a channel by id, or by name among the user's channels.
export async function channelFor(env: Env, userId: string, ref: string, needOwner = false): Promise<Channel> {
  const rows = await env.DB.prepare(
    `SELECT c.id, c.name, c.owner_id, c.created_at, m.role
     FROM channels c JOIN channel_members m ON m.channel_id = c.id AND m.user_id = ?
     WHERE c.id = ? OR lower(c.name) = lower(?)`,
  )
    .bind(userId, ref, ref)
    .all<Channel>()
  const exact = rows.results.find(c => c.id === ref)
  const channel = exact ?? (rows.results.length === 1 ? rows.results[0] : undefined)
  if (!channel) throw new UserError(404, rows.results.length > 1 ? `Several channels are named "${ref}"; use its id.` : `No channel "${ref}".`)
  if (needOwner && channel.role !== 'owner') throw new UserError(403, `Only the owner of "${channel.name}" can do that.`)
  return channel
}

export async function createChannel(env: Env, userId: string, name: string) {
  const clean = name.trim()
  if (!CHANNEL_NAME.test(clean)) throw new UserError(400, 'Channel names are 1-48 letters, digits, spaces, . \' - or _.')
  const id = randomId(8)
  const at = now()
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO channels (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)`).bind(id, clean, userId, at),
    env.DB.prepare(`INSERT INTO channel_members (channel_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)`).bind(id, userId, at),
  ])
  return channelFor(env, userId, id)
}

export async function renameChannel(env: Env, userId: string, ref: string, name: string) {
  const channel = await channelFor(env, userId, ref, true)
  const clean = name.trim()
  if (!CHANNEL_NAME.test(clean)) throw new UserError(400, 'Channel names are 1-48 letters, digits, spaces, . \' - or _.')
  await env.DB.prepare(`UPDATE channels SET name = ? WHERE id = ?`).bind(clean, channel.id).run()
  return { ...channel, name: clean }
}

export async function deleteChannel(env: Env, userId: string, ref: string) {
  const channel = await channelFor(env, userId, ref, true)
  await env.DB.prepare(`DELETE FROM channels WHERE id = ?`).bind(channel.id).run()
  await roomCall(env, channel.id, '/destroy', { method: 'POST' })
  return channel
}

export async function channelDetail(env: Env, userId: string, ref: string) {
  const channel = await channelFor(env, userId, ref)
  const [members, connections, invites, presence] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id, u.login, u.name, u.avatar_url, m.role, m.added_at FROM channel_members m JOIN users u ON u.id = m.user_id
       WHERE m.channel_id = ? ORDER BY m.role DESC, u.login`,
    )
      .bind(channel.id)
      .all<User & { role: string; added_at: number }>(),
    env.DB.prepare(
      `SELECT c.id, c.member, c.created_at, c.last_seen_at, c.token_hash IS NOT NULL AS is_active, u.login
       FROM connections c JOIN users u ON u.id = c.user_id WHERE c.channel_id = ? ORDER BY c.member`,
    )
      .bind(channel.id)
      .all<{ id: string; member: string; created_at: number; last_seen_at: number | null; is_active: number; login: string }>(),
    channel.role === 'owner'
      ? env.DB.prepare(`SELECT code, max_uses, uses, expires_at, created_at FROM invites WHERE channel_id = ? ORDER BY created_at DESC`)
          .bind(channel.id)
          .all<{ code: string; max_uses: number | null; uses: number; expires_at: number | null; created_at: number }>()
      : Promise.resolve({ results: [] }),
    roomCall<{ online: string[] }>(env, channel.id, '/presence'),
  ])
  const online = new Set(presence.online)
  return {
    channel,
    members: members.results,
    connections: connections.results
      .filter(c => c.is_active)
      .map(({ is_active, ...c }) => ({ ...c, isOnline: online.has(c.member) })),
    invites: invites.results,
  }
}

// --- membership ----------------------------------------------------------------

export async function addMember(env: Env, userId: string, ref: string, login: string) {
  const channel = await channelFor(env, userId, ref, true)
  const user = await userByLogin(env, login)
  await env.DB.prepare(`INSERT INTO channel_members (channel_id, user_id, role, added_at) VALUES (?, ?, 'member', ?) ON CONFLICT DO NOTHING`)
    .bind(channel.id, user.id, now())
    .run()
  return { channel, user }
}

// The owner removes anyone else; anyone removes themself (leaving).
export async function removeMember(env: Env, userId: string, ref: string, login: string) {
  const channel = await channelFor(env, userId, ref)
  const target = await env.DB.prepare(`SELECT id, login FROM users WHERE login = ?`).bind(login.replace(/^@/, '').toLowerCase()).first<User>()
  if (!target) throw new UserError(404, `No user ${login}.`)
  if (target.id !== userId && channel.role !== 'owner') throw new UserError(403, 'Only the owner can remove other members.')
  if (target.id === channel.owner_id) throw new UserError(400, 'The owner cannot leave; delete the channel instead.')
  const conns = await env.DB.prepare(`SELECT member FROM connections WHERE channel_id = ? AND user_id = ?`).bind(channel.id, target.id).all<{ member: string }>()
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM connections WHERE channel_id = ? AND user_id = ?`).bind(channel.id, target.id),
    env.DB.prepare(`DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?`).bind(channel.id, target.id),
  ])
  await Promise.all(conns.results.map(c => roomCall(env, channel.id, '/forget', { method: 'POST', member: c.member })))
  return { channel, user: target }
}

// --- invites ----------------------------------------------------------------

export async function createInvite(env: Env, userId: string, ref: string, opts: { maxUses?: number; expiresInHours?: number }) {
  const channel = await channelFor(env, userId, ref, true)
  const code = randomId(9)
  const expiresAt = opts.expiresInHours ? now() + opts.expiresInHours * 3600_000 : now() + 7 * 24 * 3600_000
  await env.DB.prepare(`INSERT INTO invites (code, channel_id, created_by, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(code, channel.id, userId, opts.maxUses ?? null, expiresAt, now())
    .run()
  return { channel, code, maxUses: opts.maxUses ?? null, expiresAt }
}

export async function revokeInvite(env: Env, userId: string, code: string) {
  const invite = await env.DB.prepare(`SELECT channel_id FROM invites WHERE code = ?`).bind(code).first<{ channel_id: string }>()
  if (!invite) throw new UserError(404, 'No such invite.')
  await channelFor(env, userId, invite.channel_id, true)
  await env.DB.prepare(`DELETE FROM invites WHERE code = ?`).bind(code).run()
}

export async function peekInvite(env: Env, code: string) {
  const invite = await env.DB.prepare(
    `SELECT i.code, i.max_uses, i.uses, i.expires_at, c.id AS channel_id, c.name AS channel_name, u.login AS owner_login
     FROM invites i JOIN channels c ON c.id = i.channel_id JOIN users u ON u.id = c.owner_id WHERE i.code = ?`,
  )
    .bind(code)
    .first<{ code: string; max_uses: number | null; uses: number; expires_at: number | null; channel_id: string; channel_name: string; owner_login: string }>()
  if (!invite) throw new UserError(404, 'This invite does not exist or was revoked.')
  if (invite.expires_at !== null && invite.expires_at < now()) throw new UserError(400, 'This invite has expired.')
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) throw new UserError(400, 'This invite has been used up.')
  return invite
}

export async function acceptInvite(env: Env, userId: string, codeOrLink: string) {
  const code = codeOrLink.trim().split('/').pop()!
  const invite = await peekInvite(env, code)
  const added = await env.DB.prepare(`INSERT INTO channel_members (channel_id, user_id, role, added_at) VALUES (?, ?, 'member', ?) ON CONFLICT DO NOTHING`)
    .bind(invite.channel_id, userId, now())
    .run()
  if (added.meta.changes > 0) await env.DB.prepare(`UPDATE invites SET uses = uses + 1 WHERE code = ?`).bind(code).run()
  return channelFor(env, userId, invite.channel_id)
}

// --- connections (one per Claude Code session) --------------------------------

// A one-time code for a session to connect with. The session names itself
// when it claims the code; Claude never picks a name.
export async function createClaim(env: Env, userId: string, ref: string) {
  const channel = await channelFor(env, userId, ref)
  const claim = randomId(18)
  await env.DB.prepare(`INSERT INTO claims (hash, channel_id, user_id, expires_at) VALUES (?, ?, ?, ?)`)
    .bind(await sha256(claim), channel.id, userId, now() + CLAIM_TTL_MS)
    .run()
  return { channel, claim }
}

// The session's side: the code becomes that session's own connection, named
// <login>.<session>. The same session connecting again takes its name back.
export async function claimConnection(env: Env, claim: string, session: string) {
  if (!SESSION.test(session)) throw new UserError(400, 'The session name must be 1-40 lowercase letters, digits or -.')
  const hash = await sha256(claim)
  const row = await env.DB.prepare(
    `SELECT k.channel_id, k.user_id, k.expires_at, c.name AS channel_name, u.login
     FROM claims k JOIN channels c ON c.id = k.channel_id JOIN users u ON u.id = k.user_id WHERE k.hash = ?`,
  )
    .bind(hash)
    .first<{ channel_id: string; user_id: string; expires_at: number; channel_name: string; login: string }>()
  await env.DB.prepare(`DELETE FROM claims WHERE hash = ? OR expires_at < ?`).bind(hash, now()).run()
  if (!row || row.expires_at < now()) throw new UserError(400, 'This connect code is invalid, used or expired; make a new one.')

  const member = `${row.login}.${session}`
  const token = `crt_${randomId(24)}`
  const previous = await env.DB.prepare(`SELECT id FROM connections WHERE channel_id = ? AND member = ?`).bind(row.channel_id, member).first<{ id: string }>()
  await env.DB.prepare(
    `INSERT INTO connections (id, channel_id, user_id, member, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, last_seen_at = excluded.last_seen_at`,
  )
    .bind(previous?.id ?? randomId(), row.channel_id, row.user_id, member, await sha256(token), now(), now())
    .run()
  await roomCall(env, row.channel_id, '/register', { method: 'POST', member })
  return { token, channelId: row.channel_id, channel: row.channel_name, member }
}

// Who a message in the channel may be addressed to: a connected session, or
// a member's login (all their sessions get it, and the website shows it).
export async function checkRecipient(env: Env, channelId: string, to: string | null | undefined) {
  if (to === null || to === undefined) return
  const known = await env.DB.prepare(
    `SELECT 1 FROM connections WHERE channel_id = ?1 AND member = ?2 AND token_hash IS NOT NULL
     UNION SELECT 1 FROM channel_members m JOIN users u ON u.id = m.user_id WHERE m.channel_id = ?1 AND u.login = ?2`,
  )
    .bind(channelId, to)
    .first()
  if (!known) throw new UserError(404, `Nobody in this channel is called ${to}.`)
}

export async function connectionByToken(env: Env, token: string) {
  const row = await env.DB.prepare(
    `SELECT k.id, k.channel_id, k.member, k.user_id, c.name AS channel_name FROM connections k
     JOIN channels c ON c.id = k.channel_id
     JOIN channel_members m ON m.channel_id = k.channel_id AND m.user_id = k.user_id
     WHERE k.token_hash = ?`,
  )
    .bind(await sha256(token))
    .first<{ id: string; channel_id: string; member: string; user_id: string; channel_name: string }>()
  if (row) await env.DB.prepare(`UPDATE connections SET last_seen_at = ? WHERE id = ?`).bind(now(), row.id).run()
  return row
}

export async function listConnections(env: Env, userId: string) {
  return env.DB.prepare(
    `SELECT k.id, k.member, k.channel_id, c.name AS channel_name, k.created_at, k.last_seen_at
     FROM connections k JOIN channels c ON c.id = k.channel_id WHERE k.user_id = ? AND k.token_hash IS NOT NULL ORDER BY c.name, k.member`,
  )
    .bind(userId)
    .all<{ id: string; member: string; channel_id: string; channel_name: string; created_at: number; last_seen_at: number | null }>()
    .then(r => r.results)
}

// Your own connections, or anyone's in a channel you own.
export async function deleteConnection(env: Env, userId: string, connectionId: string) {
  const row = await env.DB.prepare(`SELECT k.channel_id, k.member, k.user_id, c.owner_id FROM connections k JOIN channels c ON c.id = k.channel_id WHERE k.id = ?`)
    .bind(connectionId)
    .first<{ channel_id: string; member: string; user_id: string; owner_id: string }>()
  if (!row || (row.user_id !== userId && row.owner_id !== userId)) throw new UserError(404, 'No such connection.')
  await env.DB.prepare(`DELETE FROM connections WHERE id = ?`).bind(connectionId).run()
  await roomCall(env, row.channel_id, '/forget', { method: 'POST', member: row.member })
  return row
}

// --- messages ----------------------------------------------------------------

export async function readMessages(env: Env, userId: string, ref: string, limit = 30) {
  const channel = await channelFor(env, userId, ref)
  const { messages } = await roomCall<{ messages: RoomMessage[] }>(env, channel.id, `/history?limit=${limit}`)
  return { channel, messages }
}

// Posts as the user themself (their login), from the website or MCP.
export async function postMessage(env: Env, userId: string, ref: string, text: string, to?: string) {
  const channel = await channelFor(env, userId, ref)
  await checkRecipient(env, channel.id, to)
  const user = (await getUser(env, userId))!
  const sent = await roomCall<{ seq: number }>(env, channel.id, '/messages', {
    method: 'POST',
    member: user.login,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: crypto.randomUUID(), to: to ?? null, text }),
  })
  return { channel, seq: sent.seq }
}
