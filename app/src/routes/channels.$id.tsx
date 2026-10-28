import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { ago, api, useApi, type ChannelDetail, type Message } from '../lib/api'

export const Route = createFileRoute('/channels/$id')({ component: ChannelPage })

function ChannelPage() {
  const { id } = Route.useParams()
  const detail = useApi<ChannelDetail>(`/channels/${id}`)
  const [error, setError] = useState<string>()

  const act = async (run: () => Promise<unknown>) => {
    setError(undefined)
    try {
      await run()
      detail.reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (detail.error) return <div className="error">{detail.error}</div>
  if (!detail.data) return null
  const { channel, members, connections, invites } = detail.data
  const isOwner = channel.role === 'owner'

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>{channel.name}</h1>
        {isOwner && (
          <div className="row">
            <button
              onClick={() => {
                const name = prompt('Rename channel', channel.name)
                if (name) act(() => api(`/channels/${id}`, { method: 'PATCH', body: { name } }))
              }}
            >
              Rename
            </button>
            <button
              className="danger"
              onClick={() =>
                confirm(`Delete "${channel.name}" with its history and connections?`) &&
                act(() => api(`/channels/${id}`, { method: 'DELETE' })).then(() => location.assign('/'))
              }
            >
              Delete
            </button>
          </div>
        )}
      </div>
      <p className="lead">
        <code>{channel.id}</code> · {isOwner ? 'You own this channel' : 'Member'}
      </p>
      {error && <div className="error">{error}</div>}

      <div className="split">
        <div>
          <div className="panel">
            <h2>Connected sessions</h2>
            <ul className="list">
              {connections.map(k => (
                <li key={k.id}>
                  <span>
                    <span className={`dot ${k.isOnline ? 'on' : ''}`} />
                    room:{k.member} <span className="muted">· {k.isOnline ? 'online' : `seen ${ago(k.last_seen_at)}`}</span>
                    {k.agents.map(a => (
                      <div key={a.name} className="muted" style={{ paddingLeft: 14 }}>
                        room:{k.member}/{a.name}
                        {a.type ? ` · ${a.type}` : ''}
                      </div>
                    ))}
                  </span>
                  <button className="link" onClick={() => act(() => api(`/connections/${k.id}`, { method: 'DELETE' }))}>
                    Disconnect
                  </button>
                </li>
              ))}
              {connections.length === 0 && <li className="muted">No sessions connected yet.</li>}
            </ul>
            <ConnectCode channelId={id} />
          </div>

          <div className="panel">
            <h2>People</h2>
            <ul className="list">
              {members.map(m => (
                <li key={m.id}>
                  <span>
                    {m.login} {m.role === 'owner' && <span className="pill">owner</span>}
                  </span>
                  {isOwner && m.role !== 'owner' && (
                    <button className="link" onClick={() => act(() => api(`/channels/${id}/members/${m.login}`, { method: 'DELETE' }))}>
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {isOwner && <AddMember onAdd={login => act(() => api(`/channels/${id}/members`, { method: 'POST', body: { login } }))} />}
          </div>

          {isOwner && (
            <div className="panel">
              <h2>Invite links</h2>
              <ul className="list">
                {invites.map(i => (
                  <li key={i.code}>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <code>/invite/{i.code}</code>{' '}
                      <span className="muted">
                        {i.uses}
                        {i.max_uses ? `/${i.max_uses}` : ''} used · expires {i.expires_at ? new Date(i.expires_at).toLocaleDateString() : 'never'}
                      </span>
                    </span>
                    <span className="row">
                      <button className="link" onClick={() => navigator.clipboard.writeText(`${location.origin}/invite/${i.code}`)}>
                        Copy
                      </button>
                      <button className="link" onClick={() => act(() => api(`/invites/${i.code}`, { method: 'DELETE' }))}>
                        Revoke
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
              <button style={{ marginTop: 10 }} onClick={() => act(() => api(`/channels/${id}/invites`, { method: 'POST', body: {} }))}>
                New invite link
              </button>
            </div>
          )}
        </div>

        <Messages channelId={id} />
      </div>
    </>
  )
}

function ConnectCode({ channelId }: { channelId: string }) {
  const [claimUrl, setClaimUrl] = useState<string>()
  const [error, setError] = useState<string>()
  return (
    <div style={{ marginTop: 12 }}>
      <button onClick={() => api<{ claimUrl: string }>(`/channels/${channelId}/connect`, { method: 'POST', body: {} }).then(r => setClaimUrl(r.claimUrl), e => setError(e.message))}>
        Connect a session by hand
      </button>
      {error && <div className="error">{error}</div>}
      {claimUrl && (
        <>
          <p className="muted">Paste in the Claude Code session within 10 minutes.</p>
          <pre>/room join {claimUrl}</pre>
        </>
      )}
    </div>
  )
}

function AddMember({ onAdd }: { onAdd: (login: string) => void }) {
  const [login, setLogin] = useState('')
  return (
    <div className="row" style={{ marginTop: 10 }}>
      <input placeholder="GitHub username" value={login} onChange={e => setLogin(e.target.value)} />
      <button disabled={!login.trim()} onClick={() => (onAdd(login.trim()), setLogin(''))}>
        Add
      </button>
    </div>
  )
}

function Messages({ channelId }: { channelId: string }) {
  const history = useApi<{ messages: Message[] }>(`/channels/${channelId}/messages?limit=100`)
  const [text, setText] = useState('')
  useEffect(() => {
    const timer = setInterval(history.reload, 5000)
    return () => clearInterval(timer)
  }, [history.reload])

  return (
    <div className="panel">
      <h2>Messages</h2>
      <div className="messages">
        {history.data?.messages.map(m => (
          <div key={m.seq} className="msg">
            <div className="from">
              {m.from}
              {m.to && <span className="muted"> → {m.to}</span>} <span className="muted">· {ago(m.sentAt)}</span>
            </div>
            <div className="text">{m.text}</div>
          </div>
        ))}
        {history.data?.messages.length === 0 && <div className="muted">Nothing yet.</div>}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <input style={{ flex: 1 }} placeholder="Post as yourself" value={text} onChange={e => setText(e.target.value)} />
        <button
          disabled={!text.trim()}
          onClick={() => api(`/channels/${channelId}/messages`, { method: 'POST', body: { text } }).then(() => (setText(''), history.reload()))}
        >
          Send
        </button>
      </div>
    </div>
  )
}
