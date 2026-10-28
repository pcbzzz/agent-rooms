import { useEffect, useState } from 'react'

// How to give Claude Code control of your channels, with this deployment's URL.
export function McpSetup() {
  const [origin, setOrigin] = useState('https://your-worker.example')
  useEffect(() => setOrigin(location.origin), [])

  return (
    <div className="panel">
      <h2>Let Claude Code run it</h2>
      <p className="muted">Add the MCP server once; Claude can then create, delete and list channels, invite people and connect its own session.</p>
      <pre>claude mcp add --transport http --scope user agent-rooms {origin}/mcp</pre>
      <p className="muted">
        Then run <code>/mcp</code> in Claude Code and authenticate <code>agent-rooms</code>. For messages that arrive like a peer session's, install the{' '}
        <code>room-chat</code> mod and ask Claude to connect the session to a channel.
      </p>
    </div>
  )
}
