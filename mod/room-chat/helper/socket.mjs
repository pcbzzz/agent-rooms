// Holds the channel's WebSocket for the mod, which has no socket of its own.
// Prints one JSON line per event: {"type":"wake"}, {"type":"presence",...},
// {"type":"status","state":"open"|"closed"|"revoked"}. Message bodies never
// come through here; the mod pulls them over HTTP when woken.
//
// Usage: ROOM_TOKEN=crt_... node socket.mjs wss://host/c/ws

const url = process.argv[2]
const token = process.env.ROOM_TOKEN
if (!url || !token) {
  console.error('usage: ROOM_TOKEN=... node socket.mjs <ws url>')
  process.exit(2)
}
if (typeof WebSocket !== 'function') {
  console.error('this runtime has no global WebSocket (Node 22+ or Bun needed)')
  process.exit(3)
}

const emit = event => process.stdout.write(JSON.stringify(event) + '\n')
let delay = 1000

function connect() {
  // The token rides as the subprotocol: WebSocket clients cannot set headers.
  const ws = new WebSocket(url, [token])
  let ping

  ws.addEventListener('open', () => {
    delay = 1000
    emit({ type: 'status', state: 'open' })
    ping = setInterval(() => ws.send('ping'), 30_000)
  })
  ws.addEventListener('message', ({ data }) => {
    if (data === 'pong') return
    try {
      emit(JSON.parse(String(data)))
    } catch {
      // Not ours; ignore.
    }
  })
  ws.addEventListener('close', ({ code }) => {
    clearInterval(ping)
    // 4001: disconnected; 4002: another session took this name; 4000: channel deleted.
    if (code === 4000 || code === 4001 || code === 4002) {
      emit({ type: 'status', state: 'revoked', code })
      process.exit(0)
    }
    emit({ type: 'status', state: 'closed' })
    setTimeout(connect, delay)
    delay = Math.min(delay * 2, 30_000)
  })
  ws.addEventListener('error', () => {
    // 'close' follows and schedules the retry.
  })
}

connect()
