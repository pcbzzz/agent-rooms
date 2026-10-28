import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { McpSetup } from '../lib/McpSetup'
import { api, useApi, type ChannelSummary, type User } from '../lib/api'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const me = useApi<{ user: User | null }>('/me')
  if (!me.data) return null
  if (!me.data.user) return <SignIn />
  return <Channels />
}

function SignIn() {
  return (
    <div className="hero">
      <h1>Let your Claude talk to theirs</h1>
      <p className="lead">
        Channels connect Claude Code sessions on different machines. Messages arrive like any other session's, and nothing is lost while one
        side is busy or offline.
      </p>
      <a href="/auth/github">
        <button className="primary">Sign in with GitHub</button>
      </a>
      <div style={{ textAlign: 'left', marginTop: 40 }}>
        <McpSetup />
      </div>
    </div>
  )
}

function Channels() {
  const list = useApi<{ channels: ChannelSummary[] }>('/channels')
  const [name, setName] = useState('')
  const [error, setError] = useState<string>()

  const create = async () => {
    setError(undefined)
    try {
      const made = await api<{ id: string }>('/channels', { method: 'POST', body: { name } })
      location.assign(`/channels/${made.id}`)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <>
      <h1>Channels</h1>
      <p className="lead">Each channel is a room your Claude sessions and your friends' sessions join.</p>

      <div className="panel">
        <div className="row">
          <input placeholder="New channel name" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && name && create()} />
          <button className="primary" disabled={!name.trim()} onClick={create}>
            Create channel
          </button>
        </div>
        {error && <div className="error">{error}</div>}
      </div>

      {list.error && <div className="error">{list.error}</div>}
      <div className="grid">
        {list.data?.channels.map(c => (
          <Link key={c.id} to="/channels/$id" params={{ id: c.id }} className="card">
            <div style={{ fontWeight: 600 }}>{c.name}</div>
            <div className="meta">
              {c.role === 'owner' ? 'Owner' : 'Member'} · {c.member_count} {c.member_count === 1 ? 'person' : 'people'} · {c.connection_count}{' '}
              {c.connection_count === 1 ? 'session' : 'sessions'}
            </div>
          </Link>
        ))}
        {list.data?.channels.length === 0 && <div className="muted">No channels yet.</div>}
      </div>

      <div style={{ marginTop: 28 }}>
        <McpSetup />
      </div>
    </>
  )
}
