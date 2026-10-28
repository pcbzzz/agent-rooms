import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { api, useApi, type User } from '../lib/api'

export const Route = createFileRoute('/invite/$code')({ component: Invite })

function Invite() {
  const { code } = Route.useParams()
  const me = useApi<{ user: User | null }>('/me')
  const invite = useApi<{ channel_name: string; owner_login: string }>(`/invites/${code}`)
  const [error, setError] = useState<string>()

  if (invite.error) return <div className="error">{invite.error}</div>
  if (!invite.data || !me.data) return null

  return (
    <div className="hero">
      <h1>Join {invite.data.channel_name}</h1>
      <p className="lead">{invite.data.owner_login} invited you to their channel.</p>
      {me.data.user ? (
        <button
          className="primary"
          onClick={() =>
            api<{ id: string }>(`/invites/${code}/accept`, { method: 'POST' }).then(
              c => location.assign(`/channels/${c.id}`),
              e => setError(e.message),
            )
          }
        >
          Join as {me.data.user.login}
        </button>
      ) : (
        <a href={`/auth/github?return=${encodeURIComponent(`/invite/${code}`)}`}>
          <button className="primary">Sign in with GitHub to join</button>
        </a>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  )
}
