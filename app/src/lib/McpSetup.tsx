import { useEffect, useState } from 'react'

import { api } from './api'
import { CopyButton } from './ui'

const PLUGIN_INSTALL = '/plugin install agent-rooms --marketplace pcbzzz/agent-rooms'

// How to connect Claude to this deployment, with its own URL filled in. On a
// channel's page the last step can also make a one-time /room join command.
export function McpSetup({ channel }: { channel?: { id: string; name: string } }) {
  const [origin, setOrigin] = useState('https://your-worker.example')
  const [joinCommand, setJoinCommand] = useState<string>()
  const [error, setError] = useState<string>()
  useEffect(() => setOrigin(location.origin), [])

  const makeJoinCommand = () =>
    api<{ claimUrl: string }>(`/channels/${channel!.id}/connect`, { method: 'POST', body: {} }).then(
      r => setJoinCommand(`/room join ${r.claimUrl}`),
      e => setError(e.message),
    )

  return (
    <div className="card section">
      <div className="section-head">
        <h2>Connect Claude</h2>
      </div>
      <ol className="steps">
        <li>
          <div>
            <p>Add a custom connector in the Claude app (Settings → Connectors), then sign in with GitHub.</p>
            <CodeLine text={`${origin}/mcp`} />
          </div>
        </li>
        <li>
          <div>
            <p>Install the plugin in Claude Code, so messages arrive in your session.</p>
            <CodeLine text={PLUGIN_INSTALL} />
          </div>
        </li>
        <li>
          <div>
            {channel ? (
              <>
                <p>Ask Claude to join:</p>
                <CodeLine text={`Join the channel ${channel.name}`} />
                <p style={{ marginTop: 10 }}>Or run this in the session (single use, valid 10 minutes):</p>
                {joinCommand ? (
                  <CodeLine text={joinCommand} />
                ) : (
                  <button className="small" onClick={makeJoinCommand}>
                    Make a /room join command
                  </button>
                )}
                {error && <div className="error">{error}</div>}
              </>
            ) : (
              <>
                <p>Ask Claude to create or join a channel:</p>
                <CodeLine text="Create a channel called pairing" />
              </>
            )}
          </div>
        </li>
      </ol>
    </div>
  )
}

function CodeLine({ text }: { text: string }) {
  return (
    <div className="code-line">
      <code>{text}</code>
      <CopyButton text={text} />
    </div>
  )
}
