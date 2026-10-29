// Everything outside /mcp: sign-in, the MCP OAuth consent page, the JSON API
// the web UI uses (cookie session), and the API connected sessions use
// (connection token). Anything else falls through to TanStack Start.

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider'
import { Hono, type Context } from 'hono'

import { currentUser, devLogin, endSession, githubCallback, githubRedirect, safeReturn, type AppEnv } from './auth'
import * as data from './data'
import { ensureSchema } from './schema'

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers }

export function createApp(startHandler: (request: Request) => Promise<Response>) {
  const app = new Hono<AppEnv>()

  app.use(async (c, next) => {
    await ensureSchema(c.env)
    await next()
  })

  app.onError((error, c) => {
    if (error instanceof data.UserError) return c.json({ error: error.message }, error.status)
    console.error(error)
    return c.json({ error: 'Something went wrong.' }, 500)
  })

  // --- sign-in ---------------------------------------------------------------

  app.get('/auth/github', c => githubRedirect(c, safeReturn(c.req.query('return'))))
  app.get('/auth/github/callback', githubCallback)
  app.get('/auth/dev', devLogin)
  app.post('/auth/logout', async c => (await endSession(c), c.json({ ok: true })))

  // --- MCP OAuth: Claude Code's `claude mcp add` lands here -------------------

  app.get('/authorize', async c => {
    const user = await currentUser(c)
    if (!user) return c.redirect(`/auth/github?return=${encodeURIComponent(new URL(c.req.url).pathname + new URL(c.req.url).search)}`)
    return withOAuthErrors(c, async oauth => {
      const request = await oauth.parseAuthRequest(c.req.raw)
      const details = await oauth.describeConsent(request)
      const consent = await oauth.beginConsent(request)
      consent.headers.set('Content-Type', 'text/html; charset=utf-8')
      return new Response(consentPage(details, consent.handle, user.login), { headers: consent.headers })
    })
  })

  app.post('/authorize', async c => {
    const user = await currentUser(c)
    if (!user) return c.text('Your sign-in expired. Start the connection again.', 401)
    return withOAuthErrors(c, async oauth => {
      const form = await c.req.formData()
      const handle = String(form.get('handle'))
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(c.req.raw, handle)
        denied.headers.set('Location', denied.redirectTo)
        return new Response(null, { status: 302, headers: denied.headers })
      }
      const approved = await oauth.approveConsent(c.req.raw, handle)
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: user.id,
        metadata: { login: user.login },
        scope: approved.request.scope,
        props: { userId: user.id, login: user.login },
      })
      approved.headers.set('Location', redirectTo)
      return new Response(null, { status: 302, headers: approved.headers })
    })
  })

  // --- web API (cookie session) ------------------------------------------------

  const web = new Hono<AppEnv>()
  web.use(async (c, next) => {
    const user = await currentUser(c)
    if (!user && c.req.path !== '/api/me' && !c.req.path.startsWith('/api/invites/')) return c.json({ error: 'Sign in first.' }, 401)
    c.set('user', user)
    await next()
  })
  const uid = (c: Context<AppEnv>) => c.get('user')!.id

  web.get('/me', c => c.json({ user: c.get('user') }))
  web.get('/channels', async c => c.json({ channels: await data.listChannels(c.env, uid(c)) }))
  web.post('/channels', async c => {
    const { name, encrypted } = await c.req.json<{ name: string; encrypted?: boolean }>()
    return c.json(await data.createChannel(c.env, uid(c), name, !!encrypted))
  })
  web.get('/channels/:id', async c => c.json(await data.channelDetail(c.env, uid(c), c.req.param('id'))))
  web.patch('/channels/:id', async c => c.json(await data.renameChannel(c.env, uid(c), c.req.param('id'), (await c.req.json<{ name: string }>()).name)))
  web.post('/channels/:id/encrypt', async c => {
    const { clearHistory } = await c.req.json<{ clearHistory?: boolean }>().catch(() => ({ clearHistory: false }))
    return c.json(await data.encryptChannel(c.env, uid(c), c.req.param('id'), !!clearHistory))
  })
  web.delete('/channels/:id', async c => c.json(await data.deleteChannel(c.env, uid(c), c.req.param('id'))))
  web.get('/channels/:id/messages', async c => c.json(await data.readMessages(c.env, uid(c), c.req.param('id'), Number(c.req.query('limit') ?? 50))))
  web.post('/channels/:id/messages', async c => {
    const body = await c.req.json<{ text?: string; files?: unknown; envelope?: unknown; device?: string; to?: string }>()
    return c.json(await data.postMessage(c.env, uid(c), c.req.param('id'), body, body.to || undefined))
  })
  web.get('/channels/:id/devices', async c => c.json(await data.channelDevicesFor(c.env, uid(c), c.req.param('id'))))
  web.post('/channels/:id/devices', async c => c.json(await data.addChannelDevice(c.env, uid(c), c.req.param('id'), (await c.req.json<{ device: string }>()).device)))
  web.post('/channels/:id/files', async c => {
    const channel = await data.channelFor(c.env, uid(c), c.req.param('id'))
    return c.json(await data.putFile(c.env, channel.id, await c.req.arrayBuffer()))
  })
  web.get('/channels/:id/files/:file', async c => {
    const channel = await data.channelFor(c.env, uid(c), c.req.param('id'))
    return data.getFile(c.env, channel.id, c.req.param('file'))
  })
  web.post('/devices', async c => c.json(await data.registerDevice(c.env, uid(c), { ...(await c.req.json<data.DeviceKeys>()), kind: 'browser' })))
  web.get('/devices/:id/state', async c => c.json(await data.deviceState(c.env, uid(c), c.req.param('id'))))
  web.put('/devices/:id/state', async c => c.json(await data.deviceState(c.env, uid(c), c.req.param('id'), (await c.req.json<{ state: string }>()).state)))
  web.post('/channels/:id/members', async c => c.json(await data.addMember(c.env, uid(c), c.req.param('id'), (await c.req.json<{ login: string }>()).login)))
  web.delete('/channels/:id/members/:login', async c => c.json(await data.removeMember(c.env, uid(c), c.req.param('id'), c.req.param('login'))))
  web.post('/channels/:id/invites', async c => {
    const body = await c.req.json<{ maxUses?: number; expiresInHours?: number }>()
    return c.json(await data.createInvite(c.env, uid(c), c.req.param('id'), body))
  })
  web.post('/channels/:id/connect', async c => {
    const made = await data.createClaim(c.env, uid(c), c.req.param('id'))
    return c.json({ claimUrl: `${new URL(c.req.url).origin}/c/claim/${made.claim}` })
  })
  web.delete('/connections/:id', async c => c.json(await data.deleteConnection(c.env, uid(c), c.req.param('id'))))
  web.get('/invites/:code', async c => c.json(await data.peekInvite(c.env, c.req.param('code'))))
  web.post('/invites/:code/accept', async c => {
    if (!c.get('user')) return c.json({ error: 'Sign in first.' }, 401)
    return c.json(await data.acceptInvite(c.env, uid(c), c.req.param('code')))
  })
  web.delete('/invites/:code', async c => (await data.revokeInvite(c.env, uid(c), c.req.param('code')), c.json({ ok: true })))
  app.route('/api', web)

  // --- connected sessions (the agent-rooms plugin) -----------------------------------

  app.post('/c/claim/:claim', async c => {
    const { session, device } = await c.req.json<{ session?: string; device?: data.DeviceKeys }>().catch(() => ({ session: undefined, device: undefined }))
    const made = await data.claimConnection(c.env, c.req.param('claim'), session ?? 'session', device)
    return c.json({ ...made, url: new URL(c.req.url).origin })
  })

  const session = new Hono<AppEnv & { Variables: { conn: NonNullable<Awaited<ReturnType<typeof data.connectionByToken>>> } }>()
  session.use(async (c, next) => {
    // The socket helper sends the token as a WebSocket subprotocol; everything else as a bearer token.
    const header = c.req.header('Authorization')?.replace(/^Bearer /, '')
    const protocol = c.req.header('Sec-WebSocket-Protocol')?.split(',').map(p => p.trim()).find(p => p.startsWith('crt_'))
    const conn = await data.connectionByToken(c.env, header ?? protocol ?? '')
    if (!conn) return c.json({ error: 'This session was disconnected. Connect it again.' }, 401)
    c.set('conn', conn)
    await next()
  })
  const forward = (path: string) => async (c: Context<any>) => {
    const conn = c.get('conn')
    const headers = new Headers(c.req.raw.headers)
    headers.set('X-Room-Member', conn.member)
    return data.room(c.env, conn.channel_id).fetch(new Request(`https://room${path}`, { method: c.req.method, headers, body: c.req.raw.body }))
  }
  session.get('/ws', forward('/ws'))
  session.get('/messages', forward('/messages'))
  session.post('/messages', async c => {
    const conn = c.get('conn')
    const body = await c.req.json<{ id: string; to?: string | null; text?: string; files?: unknown; envelope?: unknown }>()
    const text = data.messageBody(conn, body, conn.device_id)
    await data.checkRecipient(c.env, conn.channel_id, body.to)
    return data.room(c.env, conn.channel_id).fetch('https://room/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Room-Member': conn.member },
      body: JSON.stringify({ id: body.id, to: body.to ?? null, text }),
    })
  })
  session.get('/devices', async c => c.json({ devices: await data.channelDevices(c.env, c.get('conn').channel_id) }))
  session.post('/files', async c => c.json(await data.putFile(c.env, c.get('conn').channel_id, await c.req.arrayBuffer())))
  session.get('/files/:file', c => data.getFile(c.env, c.get('conn').channel_id, c.req.param('file')))
  session.post('/ack', forward('/ack'))
  // The session leaves on its own: its connection is deleted and its name freed.
  session.post('/leave', async c => {
    const conn = c.get('conn')
    await data.deleteConnection(c.env, conn.user_id, conn.id)
    return c.json({ ok: true })
  })
  session.get('/members', async c => {
    const conn = c.get('conn')
    const detail = await data.channelDetail(c.env, conn.user_id, conn.channel_id)
    return c.json({
      channel: conn.channel_name,
      you: conn.member,
      device: conn.device_id,
      encrypted: !!conn.encrypted,
      members: detail.connections.map(k => ({ name: k.member, login: k.login, isOnline: k.isOnline, lastSeen: k.last_seen_at })),
      people: detail.members.map(m => m.login),
    })
  })
  app.route('/c', session)

  // --- the web UI --------------------------------------------------------------

  app.all('*', c => startHandler(c.req.raw))

  return app
}

async function withOAuthErrors(c: Context<AppEnv>, run: (oauth: OAuthHelpers) => Promise<Response>): Promise<Response> {
  try {
    return await run((c.env as Bindings).OAUTH_PROVIDER)
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302)
    if (error instanceof AuthorizationError) return c.text(error.description ?? 'This authorization request is invalid.', 400)
    if (error instanceof CimdFetchError) return c.text('This app could not be verified.', 400)
    throw error
  }
}

const escape = (value: string) => value.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)

function consentPage(
  d: { clientName: string; clientDomain?: string; redirectHost: string; redirectIsLoopback: boolean },
  handle: string,
  login: string,
): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect ${escape(d.clientName)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1c1917;background:#fafaf9}
@media(prefers-color-scheme:dark){body{color:#e7e5e4;background:#1c1917}}
.card{border:1px solid #d6d3d1;border-radius:12px;padding:1.5rem}button{font:inherit;padding:.5rem 1rem;border-radius:8px;border:1px solid #a8a29e;cursor:pointer}
button[value=approve]{background:#ea580c;color:#fff;border-color:#ea580c}.warn{color:#b45309}</style></head>
<body><div class="card"><h1 style="font-size:1.3rem;margin-top:0">Let ${escape(d.clientName)} control your channels?</h1>
<p>Signed in as <strong>${escape(login)}</strong>. It will be able to create, delete and manage channels, invites and connected sessions, and read and post messages.</p>
<p>${d.clientDomain ? `Published by <strong>${escape(d.clientDomain)}</strong>.` : 'This app registered itself; its name is not verified.'}
Access goes to <strong>${escape(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just ran <code>claude mcp add</code> or started sign-in from Claude Code.</p>' : ''}
<form method="post"><input type="hidden" name="handle" value="${escape(handle)}">
<button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></form></div></body></html>`
}
