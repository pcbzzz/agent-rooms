// Web sign-in: GitHub OAuth, then an opaque session cookie whose hash is
// stored in D1. The MCP OAuth flow reuses this sign-in at /authorize.

import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'

import { getUser, randomId, sha256, upsertGithubUser, type User } from './data'

const COOKIE = 'rooms_session'
const STATE_COOKIE = 'rooms_oauth_state'
const SESSION_MS = 30 * 24 * 3600_000

export type AppEnv = { Bindings: Env; Variables: { user: User | null } }

export async function currentUser(c: Context<AppEnv>): Promise<User | null> {
  const raw = getCookie(c, COOKIE)
  if (!raw) return null
  const row = await c.env.DB.prepare(`SELECT user_id FROM web_sessions WHERE id_hash = ? AND expires_at > ?`)
    .bind(await sha256(raw), Date.now())
    .first<{ user_id: string }>()
  return row ? getUser(c.env, row.user_id) : null
}

export async function startSession(c: Context<AppEnv>, user: User) {
  const raw = randomId(24)
  await c.env.DB.prepare(`INSERT INTO web_sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)`)
    .bind(await sha256(raw), user.id, Date.now() + SESSION_MS)
    .run()
  setCookie(c, COOKIE, raw, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_MS / 1000 })
}

export async function endSession(c: Context<AppEnv>) {
  const raw = getCookie(c, COOKIE)
  if (raw) await c.env.DB.prepare(`DELETE FROM web_sessions WHERE id_hash = ?`).bind(await sha256(raw)).run()
  deleteCookie(c, COOKIE, { path: '/' })
}

// Only same-site paths, so a crafted link cannot bounce the user elsewhere.
export function safeReturn(value: string | undefined | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/'
}

export function githubRedirect(c: Context<AppEnv>, returnTo: string): Response {
  const state = randomId(16)
  setCookie(c, STATE_COOKIE, `${state}|${returnTo}`, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/auth', maxAge: 600 })
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', c.env.GITHUB_CLIENT_ID)
  url.searchParams.set('redirect_uri', new URL('/auth/github/callback', c.req.url).toString())
  url.searchParams.set('scope', 'read:user')
  url.searchParams.set('state', state)
  return c.redirect(url.toString())
}

export async function githubCallback(c: Context<AppEnv>): Promise<Response> {
  const [expected, returnTo] = (getCookie(c, STATE_COOKIE) ?? '').split('|')
  deleteCookie(c, STATE_COOKIE, { path: '/auth' })
  const code = c.req.query('code')
  if (!code || !expected || c.req.query('state') !== expected) return c.text('Sign-in expired or was tampered with. Try again.', 400)

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'agent-rooms' },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: new URL('/auth/github/callback', c.req.url).toString(),
    }),
  })
  const raw = await tokenRes.text()
  let granted: { access_token?: string; error?: string; error_description?: string } = {}
  try {
    granted = JSON.parse(raw)
  } catch {
    granted = { error: `http_${tokenRes.status}` }
  }
  if (!granted.access_token) {
    // GitHub's error code names the cause (a wrong secret, a callback URL mismatch, a used code) and holds nothing secret.
    console.error('github token exchange failed', tokenRes.status, granted.error, granted.error_description)
    return c.text(`GitHub did not grant access (${granted.error ?? 'no token'}${granted.error_description ? `: ${granted.error_description}` : ''}). Try again.`, 400)
  }
  const access_token = granted.access_token

  const ghRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${access_token}`, 'User-Agent': 'agent-rooms', Accept: 'application/vnd.github+json' },
  })
  if (!ghRes.ok) return c.text('Could not read your GitHub profile.', 400)
  const user = await upsertGithubUser(c.env, (await ghRes.json()) as { id: number; login: string; name: string | null; avatar_url: string })
  await startSession(c, user)
  return c.redirect(safeReturn(returnTo))
}

// Local testing only: signs in as any name without GitHub. Needs DEV_LOGIN=1
// (set in .dev.vars, never as a deployed var) and a localhost host.
export async function devLogin(c: Context<AppEnv>): Promise<Response> {
  const host = new URL(c.req.url).hostname
  if (c.env.DEV_LOGIN !== '1' || !['localhost', '127.0.0.1'].includes(host)) return c.notFound()
  const login = (c.req.query('login') ?? 'dev').toLowerCase()
  if (!/^[a-z0-9-]{1,39}$/.test(login)) return c.text('bad login', 400)
  const fakeId = -Array.from(login).reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 1_000_000_007, 7)
  const user = await upsertGithubUser(c.env, { id: fakeId, login, name: login, avatar_url: null })
  await startSession(c, user)
  return c.redirect(safeReturn(c.req.query('return')))
}
