import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import { McpSetup } from '../lib/McpSetup'
import { ago, api, useApi, type ChannelDetail, type Message, type User } from '../lib/api'
import * as e2e from '../lib/e2e'
import { Address, Avatar, CopyButton, Icon, splitAddress } from '../lib/ui'

export const Route = createFileRoute('/channels/$id')({ component: ChannelPage })

function ChannelPage() {
  const { id } = Route.useParams()
  const detail = useApi<ChannelDetail>(`/channels/${id}`)
  const me = useApi<{ user: User | null }>('/me')
  const devs = useApi<{ devices: e2e.ChannelDevice[] }>(`/channels/${id}/devices`)
  const [device, setDevice] = useState(e2e.current())
  // Bumped when this browser approves or denies a device, so messages are opened again.
  const [trustTick, setTrustTick] = useState(0)
  const [error, setError] = useState<string>()

  const unlock = async () => {
    const user = me.data?.user
    if (!user) return
    setError(undefined)
    try {
      const unlocked = await e2e.unlock(user)
      await api(`/channels/${id}/devices`, { method: 'POST', body: { device: unlocked.id } })
      setDevice(unlocked)
      devs.reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const decide = async (d: e2e.ChannelDevice, decision: 'approved' | 'denied') => {
    setError(undefined)
    try {
      await e2e.decide(id, d, decision)
      setTrustTick(t => t + 1)
    } catch (e) {
      setError((e as Error).message)
    }
  }

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
            {channel.encrypted ? (
              <span className="badge">
                <Icon name="lock" size={12} /> End-to-end encrypted
              </span>
            ) : null}
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
        <Messages
          channelId={id}
          recipients={[...connections.map(k => k.member), ...members.map(m => m.login)]}
          devices={devs.data?.devices ?? []}
          device={device}
          trustTick={trustTick}
          onUnlock={unlock}
          encrypted={!!channel.encrypted}
        />

        <aside className="sidebar">
          {channel.encrypted ? (
            <Devices devices={devs.data?.devices ?? []} channelId={id} device={device} trustTick={trustTick} onDecide={decide} onUnlock={unlock} />
          ) : null}

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

function Devices({
  devices,
  channelId,
  device,
  trustTick,
  onDecide,
  onUnlock,
}: {
  devices: e2e.ChannelDevice[]
  channelId: string
  device: e2e.BrowserDevice | undefined
  trustTick: number
  onDecide: (d: e2e.ChannelDevice, decision: 'approved' | 'denied') => void
  onUnlock: () => void
}) {
  void trustTick
  return (
    <div className="card section">
      <div className="section-head">
        <h2>Devices</h2>
        <span className="badge">
          <Icon name="lock" size={12} /> End-to-end encrypted
        </span>
      </div>
      {!device && (
        <div className="unlock">
          <p>Unlock this browser to read messages and approve devices.</p>
          <button className="primary small" onClick={onUnlock}>
            <Icon name="key" size={14} /> {e2e.hasPasskey() ? 'Unlock' : 'Set up a passkey'}
          </button>
        </div>
      )}
      <ul className="list">
        {devices.map(d => {
          const mine = d.id === device?.id
          const decision = e2e.decisionFor(channelId, d.id)?.decision
          return (
            <li key={d.id} className="device">
              <Icon name={d.kind === 'browser' ? 'globe' : 'terminal'} size={15} />
              <div className="grow">
                <span>
                  <b>{d.login}</b> <span className="address-session">{d.kind === 'browser' ? 'browser' : d.label}</span>
                </span>
                <div className="sub fingerprint">{e2e.fingerprint(d.id)}</div>
              </div>
              {mine ? (
                <span className="badge accent">this browser</span>
              ) : decision ? (
                <span className={`badge ${decision === 'approved' ? 'ok' : 'denied'}`}>{decision}</span>
              ) : device ? (
                <span className="row" style={{ gap: 4 }}>
                  <button className="small primary" onClick={() => onDecide(d, 'approved')}>
                    Approve
                  </button>
                  <button className="small ghost" onClick={() => onDecide(d, 'denied')}>
                    Deny
                  </button>
                </span>
              ) : (
                <span className="badge">not decided</span>
              )}
            </li>
          )
        })}
        {devices.length === 0 && <li className="list-empty">No devices yet.</li>}
      </ul>
      <p className="muted" style={{ margin: '10px 0 0' }}>
        Compare fingerprints with their owner before approving. Messages are only encrypted to devices you approve.
      </p>
    </div>
  )
}

// Newest first, with the composer on top. Opened in the browser, never on the server.
function Messages({
  channelId,
  recipients,
  devices,
  device,
  trustTick,
  onUnlock,
  encrypted,
}: {
  channelId: string
  recipients: string[]
  devices: e2e.ChannelDevice[]
  device: e2e.BrowserDevice | undefined
  trustTick: number
  onUnlock: () => void
  encrypted: boolean
}) {
  const history = useApi<{ messages: Message[] }>(`/channels/${channelId}/messages?limit=100`)
  const [opened, setOpened] = useState<Record<number, e2e.Opened>>({})
  const [text, setText] = useState('')
  const [to, setTo] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [error, setError] = useState<string>()
  const [sending, setSending] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)

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

  useEffect(() => {
    let live = true
    const list = history.data?.messages ?? []
    void Promise.all(list.map(async m => [m.seq, await e2e.openMessage(channelId, m.text)] as const)).then(pairs => {
      if (live) setOpened(Object.fromEntries(pairs))
    })
    return () => {
      live = false
    }
  }, [history.data, channelId, device, trustTick])

  const send = async () => {
    if (!text.trim() && files.length === 0) return
    setError(undefined)
    const target = to.trim() || null
    if (!encrypted) {
      setSending(true)
      try {
        const uploaded = await e2e.uploadPlain(channelId, files)
        await api(`/channels/${channelId}/messages`, { method: 'POST', body: { text, files: uploaded, to: target ?? undefined } })
        setText('')
        setFiles([])
        history.reload()
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setSending(false)
      }
      return
    }
    const reached = devices.filter(d => d.id !== device?.id && (target === null || d.sessions.includes(target) || d.login === target))
    const approved = reached.filter(d => e2e.decisionFor(channelId, d.id)?.decision === 'approved')
    if (reached.length > 0 && approved.length === 0) return setError('None of the devices this would reach is approved yet. Approve them under Devices first.')
    setSending(true)
    try {
      const { envelope, device: from } = await e2e.sealMessage(channelId, approved, text, files)
      await api(`/channels/${channelId}/messages`, { method: 'POST', body: { envelope, device: from, to: target ?? undefined } })
      setText('')
      setFiles([])
      history.reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSending(false)
    }
  }

  const messages = [...(history.data?.messages ?? [])].reverse()
  const label = (deviceId?: string) => {
    const d = devices.find(x => x.id === deviceId)
    return d ? `${d.login}'s ${d.kind === 'browser' ? 'browser' : `device "${d.label}"`}` : 'a device'
  }

  return (
    <section className="card">
      {device || !encrypted ? (
        <form
          className="composer"
          onSubmit={e => {
            e.preventDefault()
            void send()
          }}
        >
          <div className="composer-main">
            <textarea
              ref={box}
              rows={1}
              placeholder={encrypted ? 'Post as yourself, encrypted…' : 'Post as yourself…'}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send()
              }}
            />
            {files.length > 0 && (
              <div className="attachments">
                {files.map(f => (
                  <span key={f.name} className="badge">
                    {f.name}
                    <button type="button" className="ghost small" onClick={() => setFiles(files.filter(x => x !== f))}>
                      <Icon name="x" size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={e => {
              setFiles([...files, ...Array.from(e.target.files ?? [])])
              e.target.value = ''
            }}
          />
          <button type="button" className="ghost" title="Attach files" onClick={() => picker.current?.click()}>
            <Icon name="paperclip" size={16} />
          </button>
          <input className="to" list="recipients" placeholder="To everyone" value={to} onChange={e => setTo(e.target.value)} />
          <datalist id="recipients">
            {[...new Set(recipients)].map(r => (
              <option key={r} value={r} />
            ))}
          </datalist>
          <button className="primary" disabled={sending || (!text.trim() && files.length === 0)} title="Send (⌘↵)">
            <Icon name="send" size={15} />
          </button>
        </form>
      ) : (
        <div className="locked">
          <Icon name="lock" size={18} />
          <span className="grow">Messages are end-to-end encrypted. Unlock this browser to read and send them.</span>
          <button className="primary small" onClick={onUnlock}>
            <Icon name="key" size={14} /> {e2e.hasPasskey() ? 'Unlock' : 'Set up a passkey'}
          </button>
        </div>
      )}
      {error && <div className="error" style={{ margin: 12 }}>{error}</div>}
      <div className="feed">
        {messages.map(m => (
          <MessageRow key={m.seq} message={m} opened={opened[m.seq]} channelId={channelId} label={label} encrypted={encrypted} />
        ))}
        {history.data && messages.length === 0 && <div className="empty" style={{ margin: 18 }}>No messages yet.</div>}
      </div>
    </section>
  )
}

function MessageRow({
  message: m,
  opened,
  channelId,
  label,
  encrypted,
}: {
  message: Message
  opened: e2e.Opened | undefined
  channelId: string
  label: (deviceId?: string) => string
  encrypted: boolean
}) {
  const [open, setOpen] = useState(false)
  const text = opened?.status === 'ok' ? opened.payload.text : opened?.status === 'plain' ? (opened.text ?? '') : ''
  const long = text.length > 600 || text.split('\n').length > 7
  const note =
    !opened || opened.status === 'locked'
      ? 'Encrypted. Unlock this browser to read it.'
      : opened.status === 'unapproved'
        ? `From ${label(opened.device)}, which you haven't approved.`
        : opened.status === 'not-for-me'
          ? "Not encrypted for this browser: it was sent before the sender approved it, or the sender hasn't yet."
          : opened.status === 'invalid'
            ? "Couldn't be verified, so it isn't shown."
            : undefined
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
        {note ? (
          <div className="msg-note">
            <Icon name="lock" size={13} /> {note}
          </div>
        ) : (
          <>
            {encrypted && opened?.status === 'plain' && <div className="msg-note">Not encrypted; anyone with server access could read it.</div>}
            {text && <div className={`msg-text ${long && !open ? 'clamped' : ''}`}>{text}</div>}
            {long && (
              <button className="more" onClick={() => setOpen(!open)}>
                {open ? 'Show less' : 'Show more'}
              </button>
            )}
            {opened?.status === 'ok' &&
              opened.payload.files?.map(f => <Attachment key={f.id} channelId={channelId} file={f} />)}
          </>
        )}
      </div>
    </article>
  )
}

function Attachment({ channelId, file }: { channelId: string; file: NonNullable<e2e.Payload['files']>[number] }) {
  const [url, setUrl] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    void e2e.fileUrl(channelId, file).then(setUrl, () => setFailed(true))
  }, [channelId, file])
  if (failed) return <div className="msg-note">{file.name} could not be loaded.</div>
  if (file.type.startsWith('image/'))
    return url ? (
      <a href={url} target="_blank" rel="noreferrer">
        <img className="msg-image" src={url} alt={file.name} />
      </a>
    ) : (
      <div className="msg-image placeholder" />
    )
  return (
    <a className="file-chip" href={url} download={file.name}>
      <Icon name="paperclip" size={13} /> {file.name} <span className="muted">{Math.ceil(file.size / 1024)} KB</span>
    </a>
  )
}
