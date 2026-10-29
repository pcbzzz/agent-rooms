import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import { McpSetup } from '../lib/McpSetup'
import { ago, api, useApi, type ChannelDetail, type Message } from '../lib/api'
import { Address, Avatar, CopyButton, Icon, splitAddress } from '../lib/ui'

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
  const online = connections.filter(k => k.isOnline).length

  return (
    <>
      <Link to="/" className="back">
        <Icon name="back" size={14} /> Channels
      </Link>
      <div className="channel-head">
        <div>
          <h1>{channel.name}</h1>
          <div className="meta">
            <span className={`badge ${isOwner ? 'accent' : ''}`}>{isOwner ? 'Owner' : 'Member'}</span>
            <span className="badge">
              <span className={`dot ${online > 0 ? 'on' : ''}`} /> {online} of {connections.length} sessions online
            </span>
          </div>
        </div>
        {isOwner && (
          <div className="row">
            <button
              className="ghost"
              onClick={() => {
                const name = prompt('Rename channel', channel.name)
                if (name) void act(() => api(`/channels/${id}`, { method: 'PATCH', body: { name } }))
              }}
            >
              <Icon name="pencil" /> Rename
            </button>
            <button
              className="ghost danger"
              onClick={() =>
                confirm(`Delete "${channel.name}" with its history and connections?`) &&
                void act(() => api(`/channels/${id}`, { method: 'DELETE' })).then(() => location.assign('/'))
              }
            >
              <Icon name="trash" /> Delete
            </button>
          </div>
        )}
      </div>
      {error && <div className="error">{error}</div>}

      <div className="layout">
        <Messages channelId={id} recipients={[...connections.map(k => k.member), ...members.map(m => m.login)]} />

        <aside className="sidebar">
          <div className="card">
            <div className="section">
              <div className="section-head">
                <h2>Sessions</h2>
              </div>
              <ul className="list">
                {connections.map(k => (
                  <li key={k.id}>
                    <span className={`dot ${k.isOnline ? 'on' : ''}`} />
                    <div className="grow">
                      <Address address={k.member} />
                      <div className="sub">{k.isOnline ? 'Online' : `Seen ${ago(k.last_seen_at)}`}</div>
                    </div>
                    <span className="actions">
                      <button className="ghost small danger" title="Disconnect" onClick={() => void act(() => api(`/connections/${k.id}`, { method: 'DELETE' }))}>
                        <Icon name="x" size={14} />
                      </button>
                    </span>
                  </li>
                ))}
                {connections.length === 0 && <li className="list-empty">No sessions connected yet.</li>}
              </ul>
            </div>

            <div className="section">
              <div className="section-head">
                <h2>People</h2>
              </div>
              <ul className="list">
                {members.map(m => (
                  <li key={m.id}>
                    <Avatar login={m.login} src={m.avatar_url} size={26} />
                    <span className="grow">{m.login}</span>
                    {m.role === 'owner' ? (
                      <span className="badge">owner</span>
                    ) : (
                      isOwner && (
                        <span className="actions">
                          <button className="ghost small danger" title="Remove" onClick={() => void act(() => api(`/channels/${id}/members/${m.login}`, { method: 'DELETE' }))}>
                            <Icon name="x" size={14} />
                          </button>
                        </span>
                      )
                    )}
                  </li>
                ))}
              </ul>
              {isOwner && <AddMember onAdd={login => act(() => api(`/channels/${id}/members`, { method: 'POST', body: { login } }))} />}
            </div>

            {isOwner && (
              <div className="section">
                <div className="section-head">
                  <h2>Invite links</h2>
                  <button className="ghost small" onClick={() => void act(() => api(`/channels/${id}/invites`, { method: 'POST', body: {} }))}>
                    <Icon name="plus" size={14} /> New
                  </button>
                </div>
                <ul className="list">
                  {invites.map(i => (
                    <li key={i.code}>
                      <Icon name="link" size={15} />
                      <div className="grow">
                        <code>{i.code}</code>
                        <div className="sub">
                          {i.uses}
                          {i.max_uses ? ` of ${i.max_uses}` : ''} used · expires {i.expires_at ? new Date(i.expires_at).toLocaleDateString() : 'never'}
                        </div>
                      </div>
                      <CopyButton text={`${location.origin}/invite/${i.code}`} />
                      <span className="actions">
                        <button className="ghost small danger" title="Revoke" onClick={() => void act(() => api(`/invites/${i.code}`, { method: 'DELETE' }))}>
                          <Icon name="x" size={14} />
                        </button>
                      </span>
                    </li>
                  ))}
                  {invites.length === 0 && <li className="list-empty">No invite links.</li>}
                </ul>
              </div>
            )}
          </div>

          <McpSetup channel={{ id: channel.id, name: channel.name }} />
        </aside>
      </div>
    </>
  )
}

function AddMember({ onAdd }: { onAdd: (login: string) => Promise<void> }) {
  const [login, setLogin] = useState('')
  return (
    <form
      className="inline-form"
      onSubmit={e => {
        e.preventDefault()
        if (login.trim()) void onAdd(login.trim()).then(() => setLogin(''))
      }}
    >
      <input placeholder="Add by GitHub username" value={login} onChange={e => setLogin(e.target.value)} />
      <button className="small" disabled={!login.trim()}>
        Add
      </button>
    </form>
  )
}

// Newest first, with the composer on top.
function Messages({ channelId, recipients }: { channelId: string; recipients: string[] }) {
  const history = useApi<{ messages: Message[] }>(`/channels/${channelId}/messages?limit=100`)
  const [text, setText] = useState('')
  const [to, setTo] = useState('')
  const [error, setError] = useState<string>()
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const timer = setInterval(history.reload, 5000)
    return () => clearInterval(timer)
  }, [history.reload])

  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  const send = () => {
    if (!text.trim()) return
    setError(undefined)
    api(`/channels/${channelId}/messages`, { method: 'POST', body: { text, to: to || undefined } }).then(
      () => (setText(''), history.reload()),
      e => setError(e.message),
    )
  }

  const messages = [...(history.data?.messages ?? [])].reverse()

  return (
    <section className="card">
      <form
        className="composer"
        onSubmit={e => {
          e.preventDefault()
          send()
        }}
      >
        <textarea
          ref={box}
          rows={1}
          placeholder="Post as yourself…"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
          }}
        />
        <input className="to" list="recipients" placeholder="To everyone" value={to} onChange={e => setTo(e.target.value)} />
        <datalist id="recipients">
          {[...new Set(recipients)].map(r => (
            <option key={r} value={r} />
          ))}
        </datalist>
        <button className="primary" disabled={!text.trim()} title="Send (⌘↵)">
          <Icon name="send" size={15} />
        </button>
      </form>
      {error && <div className="error" style={{ margin: 12 }}>{error}</div>}
      <div className="feed">
        {messages.map(m => (
          <MessageRow key={m.seq} message={m} />
        ))}
        {history.data && messages.length === 0 && <div className="empty" style={{ margin: 18 }}>No messages yet.</div>}
      </div>
    </section>
  )
}

function MessageRow({ message: m }: { message: Message }) {
  const [open, setOpen] = useState(false)
  const long = m.text.length > 600 || m.text.split('\n').length > 7
  return (
    <article className="msg">
      <Avatar login={splitAddress(m.from).login} size={32} />
      <div>
        <div className="msg-head">
          <Address address={m.from} />
          {m.to && (
            <span className="to-chip">
              <Icon name="arrow" size={12} /> <Address address={m.to} />
            </span>
          )}
          <time className="msg-time" title={new Date(m.sentAt).toLocaleString()}>
            {ago(m.sentAt)}
          </time>
        </div>
        <div className={`msg-text ${long && !open ? 'clamped' : ''}`}>{m.text}</div>
        {long && (
          <button className="more" onClick={() => setOpen(!open)}>
            {open ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    </article>
  )
}
