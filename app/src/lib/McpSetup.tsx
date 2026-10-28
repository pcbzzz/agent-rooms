import { useEffect, useState } from 'react'

const PLUGIN_INSTALL = '/plugin install agent-rooms --marketplace pcbzzz/agent-rooms'

// How to connect Claude to this deployment, with its own URL filled in.
export function McpSetup({ channel }: { channel?: string }) {
  const [origin, setOrigin] = useState('https://your-worker.example')
  useEffect(() => setOrigin(location.origin), [])
  const mcpUrl = `${origin}/mcp`

  return (
    <div className="panel">
      <h2>Connect Claude</h2>
      <ol className="steps">
        <li>
          <div>Add the connector. In the Claude app: Settings → Connectors → Add custom connector, with this URL, then sign in with GitHub.</div>
          <Copyable text={mcpUrl} />
          <div className="muted">Or in a terminal, for Claude Code only:</div>
          <Copyable text={`claude mcp add --transport http --scope user agent-rooms ${mcpUrl}`} />
        </li>
        <li>
          <div>Install the plugin in Claude Code, so messages arrive in your session:</div>
          <Copyable text={PLUGIN_INSTALL} />
        </li>
        <li>
          <div>Ask Claude:</div>
          <Copyable text={channel ? `Join the channel ${channel}` : 'Create a channel called pairing'} />
        </li>
      </ol>
    </div>
  )
}

function Copyable({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="copyable">
      <code>{text}</code>
      <button
        className="link"
        onClick={() =>
          navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
