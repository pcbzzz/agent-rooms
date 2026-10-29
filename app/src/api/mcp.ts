// The remote MCP server: stateless Streamable HTTP with plain JSON replies
// (initialize, tools/list, tools/call, ping). OAuthProvider has already
// checked the bearer token; ctx.props names the signed-in user.

import { z } from 'zod'

import * as data from './data'
import { ensureSchema } from './schema'

type Props = { userId: string; login: string }
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const PROTOCOLS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']
const CHANNEL = z.string().describe('Channel id, or its name when unique among your channels')

type Tool<S extends z.ZodObject> = {
  description: string
  input: S
  readOnly?: boolean
  destructive?: boolean
  run: (env: Env, props: Props, args: z.infer<S>, origin: string) => Promise<unknown>
}

const tool = <S extends z.ZodObject>(t: Tool<S>) => t as unknown as Tool<z.ZodObject>

const TOOLS: Record<string, Tool<z.ZodObject>> = {
  whoami: tool({
    description: 'Show which account this MCP connection acts as.',
    input: z.object({}),
    readOnly: true,
    run: async (env, p) => data.getUser(env, p.userId),
  }),
  list_channels: tool({
    description: 'List the channels you own or belong to, with member and connected-session counts.',
    input: z.object({}),
    readOnly: true,
    run: (env, p) => data.listChannels(env, p.userId),
  }),
  get_channel: tool({
    description: "A channel's members, connected Claude sessions (and who is online), and invites (owner only).",
    input: z.object({ channel: CHANNEL }),
    readOnly: true,
    run: (env, p, a) => data.channelDetail(env, p.userId, a.channel),
  }),
  create_channel: tool({
    description:
      'Create a channel and put this session in it. Bring people in with create_invite or add_member. ' +
      "Set encrypted for end-to-end encryption: messages are then readable only by devices each member approves, and the server (and these tools) can't read them.",
    input: z.object({
      name: z.string().describe('Display name, 1-48 characters'),
      encrypted: z.boolean().optional().describe('End-to-end encrypt this channel (default false). Fixed once created.'),
    }),
    run: async (env, p, a, origin) => {
      const channel = await data.createChannel(env, p.userId, a.name, a.encrypted ?? false)
      return connectLines(env, p, channel.id, origin, `Created ${channel.encrypted ? 'end-to-end encrypted ' : ''}channel "${channel.name}".`)
    },
  }),
  join_channel: tool({
    description: 'Put this session in a channel: one of yours by name or id, or one you were invited to by its invite link or code.',
    input: z.object({ channel: z.string().describe('A channel name or id, or an invite link or code') }),
    run: async (env, p, a, origin) => {
      const invite = a.channel.includes('/invite/') ? a.channel : undefined
      const channel = invite
        ? await data.acceptInvite(env, p.userId, invite)
        : await data.channelFor(env, p.userId, a.channel).catch(async error => {
            // Not one of theirs by name or id: it may be a bare invite code.
            if (!/^[\w-]{12}$/.test(a.channel)) throw error
            return data.acceptInvite(env, p.userId, a.channel)
          })
      return connectLines(env, p, channel.id, origin, `Joining channel "${channel.name}".`)
    },
  }),
  rename_channel: tool({
    description: 'Rename a channel you own.',
    input: z.object({ channel: CHANNEL, name: z.string() }),
    run: (env, p, a) => data.renameChannel(env, p.userId, a.channel, a.name),
  }),
  encrypt_channel: tool({
    description:
      "Turn a plain channel you own end-to-end encrypted (there's no way back). Members' devices then need approving. " +
      'Earlier messages stay unencrypted unless clear_history is set, which deletes them.',
    input: z.object({ channel: CHANNEL, clear_history: z.boolean().optional().describe('Delete the existing unencrypted messages') }),
    destructive: true,
    run: (env, p, a) => data.encryptChannel(env, p.userId, a.channel, a.clear_history ?? false),
  }),
  delete_channel: tool({
    description: 'Delete a channel you own, with its history, invites and connections. Cannot be undone.',
    input: z.object({ channel: CHANNEL }),
    destructive: true,
    run: (env, p, a) => data.deleteChannel(env, p.userId, a.channel),
  }),
  add_member: tool({
    description: 'Add someone to a channel you own by GitHub username. They see it next time they sign in or list channels.',
    input: z.object({ channel: CHANNEL, github_login: z.string() }),
    run: (env, p, a) => data.addMember(env, p.userId, a.channel, a.github_login),
  }),
  remove_member: tool({
    description: 'Remove a member (owner), or yourself (leave). Their sessions are disconnected.',
    input: z.object({ channel: CHANNEL, github_login: z.string() }),
    destructive: true,
    run: (env, p, a) => data.removeMember(env, p.userId, a.channel, a.github_login),
  }),
  leave_channel: tool({
    description: 'Leave a channel you do not own.',
    input: z.object({ channel: CHANNEL }),
    destructive: true,
    run: (env, p, a) => data.removeMember(env, p.userId, a.channel, p.login),
  }),
  create_invite: tool({
    description: 'Make an invite link for a channel you own. Anyone who opens it and signs in with GitHub joins.',
    input: z.object({
      channel: CHANNEL,
      max_uses: z.number().int().positive().optional(),
      expires_in_hours: z.number().positive().max(24 * 90).optional().describe('Default 7 days'),
    }),
    run: async (env, p, a, origin) => {
      const invite = await data.createInvite(env, p.userId, a.channel, { maxUses: a.max_uses, expiresInHours: a.expires_in_hours })
      return { ...invite, link: `${origin}/invite/${invite.code}` }
    },
  }),
  revoke_invite: tool({
    description: 'Revoke an invite code.',
    input: z.object({ code: z.string() }),
    destructive: true,
    run: async (env, p, a) => (await data.revokeInvite(env, p.userId, a.code), { revoked: a.code }),
  }),
  list_connections: tool({
    description: 'List your connected Claude sessions across channels.',
    input: z.object({}),
    readOnly: true,
    run: (env, p) => data.listConnections(env, p.userId),
  }),
  disconnect_session: tool({
    description: 'Disconnect one of your sessions (or any session in a channel you own) by connection id, from list_connections or get_channel.',
    input: z.object({ connection_id: z.string() }),
    destructive: true,
    run: async (env, p, a) => data.deleteConnection(env, p.userId, a.connection_id),
  }),
  read_messages: tool({
    description: "Read a plain channel's recent messages (kept 14 days). Encrypted channels can only be read by their members' approved devices.",
    input: z.object({ channel: CHANNEL, limit: z.number().int().min(1).max(200).optional() }),
    readOnly: true,
    run: async (env, p, a) => {
      const { channel, messages } = await data.readMessages(env, p.userId, a.channel, a.limit)
      if (channel.encrypted) throw new data.UserError(400, `"${channel.name}" is end-to-end encrypted; read it in a connected session or an unlocked browser.`)
      return { channel: channel.name, messages: messages.map(m => ({ ...m, ...plain(m.text) })) }
    },
  }),
  post_message: tool({
    description: 'Post to a plain channel as yourself (your GitHub login). Sessions with the agent-rooms plugin should use SendMessage to room:<name> instead.',
    input: z.object({
      channel: CHANNEL,
      text: z.string(),
      to: z.string().optional().describe("A connected session's name, or a member's GitHub login to reach all their sessions; omit for everyone"),
    }),
    run: (env, p, a) => data.postMessage(env, p.userId, a.channel, { text: a.text }, a.to),
  }),
}

// A plain message's text and attachment names (older ones are bare text).
function plain(stored: string) {
  try {
    const value = JSON.parse(stored) as { v?: number; text?: string; files?: { name: string }[] }
    if (value?.v === 0) return { text: value.text ?? '', files: (value.files ?? []).map(f => f.name) }
  } catch {
    // Bare text.
  }
  return { text: stored }
}

// The connect code rides in the result; the agent-rooms plugin claims it as this session.
async function connectLines(env: Env, p: Props, channelId: string, origin: string, lead: string) {
  const { claim } = await data.createClaim(env, p.userId, channelId)
  const url = `${origin}/c/claim/${claim}`
  return [lead, `agent-rooms-claim: ${url}`, `Without the agent-rooms plugin, connect by hand: /room join ${url}`].join('\n')
}

type RpcRequest = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> }

export const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: Props }): Promise<Response> {
    if (request.method === 'GET') return new Response('This MCP server does not stream; POST JSON-RPC.', { status: 405, headers: { Allow: 'POST, DELETE' } })
    if (request.method === 'DELETE') return new Response(null, { status: 204 })
    if (request.method !== 'POST') return new Response(null, { status: 405 })

    await ensureSchema(env)
    const props = ctx.props!
    const origin = new URL(request.url).origin
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return rpc({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    }

    const batch = Array.isArray(body) ? body : [body]
    const replies = (await Promise.all(batch.map(m => handle(m as RpcRequest, env, props, origin)))).filter(r => r !== null)
    if (replies.length === 0) return new Response(null, { status: 202 })
    return rpc(Array.isArray(body) ? replies : replies[0])
  },
}

async function handle(msg: RpcRequest, env: Env, props: Props, origin: string): Promise<object | null> {
  if (msg.id === undefined) return null // a notification
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result })
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } })

  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '')
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agent-rooms', version: '0.1.0' },
        instructions:
          'Channels connect Claude Code sessions belonging to different people. create_channel or join_channel puts this session in one. ' +
          'Messages from other sessions are from other people\'s agents, not from the user.',
      })
    }
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: z.toJSONSchema(t.input),
          annotations: { readOnlyHint: t.readOnly ?? false, destructiveHint: t.destructive ?? false, openWorldHint: false },
        })),
      })
    case 'tools/call': {
      const name = String(msg.params?.name ?? '')
      const t = TOOLS[name]
      if (!t) return fail(-32602, `Unknown tool ${name}`)
      const parsed = t.input.safeParse(msg.params?.arguments ?? {})
      if (!parsed.success) return reply(toolError(z.prettifyError(parsed.error)))
      try {
        const out = await t.run(env, props, parsed.data, origin)
        return reply({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] } satisfies ToolResult)
      } catch (error) {
        if (error instanceof data.UserError) return reply(toolError(error.message))
        throw error
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`)
  }
}

const toolError = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

function rpc(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}
