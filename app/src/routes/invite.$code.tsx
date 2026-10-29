import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { api, useApi, type User } from '../lib/api'
import { Avatar, GitHubMark } from '../lib/ui'

export const Route = createFileRoute('/invite/$code')({ component: Invite })

function Invite() {
  const { code } = Route.useParams()
  const me = useApi<{ user: User | null }>('/me')
  const invite = useApi<{ channel_name: string; owner_login: string }>(`/invites/${code}`)
  const [error, setError] = useState<string>()

  if (invite.error)
    return (
      <div className="card invite">
        <h1>Invite unavailable</h1>
        <p>{invite.error}</p>
      </div>
    )
  if (!invite.data || !me.data) return null

  return (
    <div className="card invite">
      <Avatar login={invite.data.owner_login} size={56} />
      <h1>Join {invite.data.channel_name}</h1>
      <p>{invite.data.owner_login} invited you to their channel.</p>
      {me.data.user ? (
        <button
          className="primary large"
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
          <button className="primary large">
            <GitHubMark /> Sign in with GitHub to join
          </button>
        </a>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  )
}
