// The plugin's local helper: everything the plugin's sandbox can't do.
//
// - Holds this device's keys and its approved-device list, in files only you
//   can read (~/.claude/agent-rooms), and does all encryption with them.
// - Serves that to the plugin over a Unix socket (HTTP + JSON), mode 0600.
// - Holds a WebSocket per channel and prints one JSON line per event, naming
//   the channel: {"type":"wake","channel":...}, {"type":"status","state":...}.
//
// Usage: node helper.mjs <socket path>

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, hostname, tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import * as core from './crypto-core.mjs'

const socketPath = process.argv[2]
if (!socketPath) {
  console.error('usage: node helper.mjs <socket path>')
  process.exit(2)
}
if (typeof WebSocket !== 'function') {
  console.error('this runtime has no global WebSocket (Node 22+ or Bun needed)')
  process.exit(3)
}

const HOME = join(homedir(), '.claude', 'agent-rooms')
const DEVICE_FILE = join(HOME, 'device.json')
const TRUST_FILE = join(HOME, 'trust.json')
// Held by the one session on this machine that is asking about devices right now.
const REVIEW_LOCK = join(HOME, 'review.lock')
const LOCK_STALE_MS = 10 * 60 * 1000
const FILES_DIR = join(tmpdir(), 'agent-rooms')
const MAX_FILE = 10 * 1024 * 1024
mkdirSync(HOME, { recursive: true, mode: 0o700 })

const emit = event => process.stdout.write(JSON.stringify(event) + '\n')

// --- this device ------------------------------------------------------------

function writePrivate(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

async function loadDevice() {
  if (existsSync(DEVICE_FILE)) return JSON.parse(readFileSync(DEVICE_FILE, 'utf8'))
  const device = { ...(await core.generateDevice()), label: hostname().replace(/\.local$/, ''), createdAt: Date.now() }
  // Another session on this machine may have made one at the same moment: keep theirs.
  if (existsSync(DEVICE_FILE)) return JSON.parse(readFileSync(DEVICE_FILE, 'utf8'))
  writePrivate(DEVICE_FILE, device)
  return device
}
const device = await loadDevice()
const publicDevice = () => ({ id: device.id, signPub: device.signPub, encPub: device.encPub, label: device.label })

// --- device decisions, shared by every session and channel on this machine -----------

// { version: 2, devices: { [id]: decision }, later: { [id]: until } }. Before
// version 2 decisions were kept per channel: the latest one for each device wins.
function readTrust() {
  const raw = existsSync(TRUST_FILE) ? JSON.parse(readFileSync(TRUST_FILE, 'utf8')) : {}
  if (raw.version === 2) return raw
  const devices = {}
  for (const channel of Object.values(raw))
    for (const [id, d] of Object.entries(channel)) if (!devices[id] || devices[id].at < d.at) devices[id] = d
  return { version: 2, devices, later: {} }
}

function decide(other, decision) {
  const trust = readTrust()
  // 'undecided' takes a decision back: the device is asked about again.
  if (decision === 'undecided') delete trust.devices[other.id]
  else trust.devices[other.id] = { decision, signPub: other.signPub, encPub: other.encPub, login: other.login, label: other.label, at: Date.now() }
  delete trust.later[other.id]
  writePrivate(TRUST_FILE, trust)
}

function deferDevice(id, until) {
  const trust = readTrust()
  trust.later[id] = until
  writePrivate(TRUST_FILE, trust)
}

// Only one session asks at a time; the lock is taken over once its holder is gone.
function takeReviewLock() {
  try {
    writeFileSync(REVIEW_LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx', mode: 0o600 })
    return true
  } catch {
    const held = (() => {
      try {
        return JSON.parse(readFileSync(REVIEW_LOCK, 'utf8'))
      } catch {
        return {}
      }
    })()
    if (held.pid === process.pid) return true
    if (alive(held.pid) && Date.now() - (held.at ?? 0) < LOCK_STALE_MS) return false
    rmSync(REVIEW_LOCK, { force: true })
    return takeReviewLock()
  }
}

function dropReviewLock() {
  try {
    if (JSON.parse(readFileSync(REVIEW_LOCK, 'utf8')).pid === process.pid) rmSync(REVIEW_LOCK, { force: true })
  } catch {
    // Not held.
  }
}

function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// --- server calls ----------------------------------------------------------------

async function server(s, path, init = {}) {
  const res = await fetch(`${s.url}/c/${path}`, { ...init, headers: { Authorization: `Bearer ${s.token}`, ...init.headers } })
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim())
  return res
}

async function uploadFile(s, path) {
  const bytes = readFileSync(path)
  if (bytes.length > MAX_FILE) throw new Error(`${basename(path)} is over 10 MB`)
  const sealed = await core.encryptFile(bytes)
  const { id } = await (await server(s, 'files', { method: 'POST', body: sealed.ct, headers: { 'Content-Type': 'application/octet-stream' } })).json()
  return { id, name: basename(path), type: mimeOf(path), size: bytes.length, key: sealed.key, iv: sealed.iv }
}

// A plain channel's files go up as they are.
async function uploadPlain(s, path) {
  const bytes = readFileSync(path)
  if (bytes.length > MAX_FILE) throw new Error(`${basename(path)} is over 10 MB`)
  const { id } = await (await server(s, 'files', { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } })).json()
  return { id, name: basename(path), type: mimeOf(path), size: bytes.length }
}

// Saves an attachment where the session can Read it; decrypts it when it carries a key.
async function downloadFile(s, channelId, file) {
  const raw = new Uint8Array(await (await server(s, `files/${encodeURIComponent(file.id)}`)).arrayBuffer())
  const bytes = file.key ? await core.decryptFile(raw, file) : raw
  const dir = join(FILES_DIR, channelId.replace(/[^\w-]/g, ''))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${file.id.slice(0, 8)}-${file.name.replace(/[^\w.-]+/g, '_').slice(-80)}`)
  writeFileSync(path, bytes, { mode: 0o600 })
  return { name: file.name, type: file.type, path }
}

function mimeOf(path) {
  const ext = path.toLowerCase().split('.').pop()
  return (
    { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json' }[ext] ??
    'application/octet-stream'
  )
}

// --- the API the plugin calls ----------------------------------------------------

const routes = {
  'GET /device': async () => publicDevice(),

  'GET /trust': async () => {
    const { devices, later } = readTrust()
    return { devices, later }
  },
  'POST /trust': async body => (decide(body.device, body.decision), { ok: true }),
  'POST /later': async body => (deferDevice(body.id, body.until), { ok: true }),
  'POST /review/lock': async () => ({ ok: takeReviewLock() }),
  'POST /review/unlock': async () => (dropReviewLock(), { ok: true }),

  // Encrypts text (and files) for the given devices; the files are uploaded encrypted.
  'POST /seal': async body => {
    const files = await Promise.all((body.files ?? []).map(path => uploadFile(body.server, path)))
    const envelope = await core.seal({ channelId: body.channelId, sender: device, recipients: [publicDevice(), ...body.recipients], payload: { text: body.text, files } })
    return { envelope }
  },

  // Opens an envelope from an approved device; files land in /tmp/agent-rooms.
  'POST /open': async body => {
    const { channelId, envelope } = body
    const sender = envelope.from === device.id ? publicDevice() : readTrust().devices[envelope.from]
    if (!sender || (envelope.from !== device.id && sender.decision !== 'approved')) return { status: 'untrusted', device: envelope.from }
    try {
      const payload = await core.open({ channelId, envelope, me: device, senderSignPub: sender.signPub })
      const files = await Promise.all(
        (payload.files ?? []).map(f => downloadFile(body.server, channelId, f).catch(error => ({ name: f.name, type: f.type, error: String(error.message ?? error) }))),
      )
      return { status: 'ok', text: payload.text ?? '', files }
    } catch (error) {
      return { status: error.code === 'not-for-me' ? 'not-for-me' : 'invalid', error: String(error.message ?? error) }
    }
  },

  // Plain channels: files as they are.
  'POST /upload': async body => ({ files: await Promise.all((body.files ?? []).map(path => uploadPlain(body.server, path))) }),
  'POST /download': async body => ({
    files: await Promise.all(
      (body.files ?? []).map(f => downloadFile(body.server, body.channelId, f).catch(error => ({ name: f.name, type: f.type, error: String(error.message ?? error) }))),
    ),
  }),

  'POST /connect': async body => (openSocket(body.channel, body.wsUrl, body.token), { ok: true }),
  // Without a channel, closes them all.
  'POST /disconnect': async body => (body.channel ? closeSocket(body.channel) : [...sockets.keys()].forEach(closeSocket), { ok: true }),
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://helper')
  const route = routes[`${req.method} ${url.pathname}`]
  const reply = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(value))
  }
  if (!route) return reply(404, { error: 'not found' })
  try {
    let raw = ''
    for await (const chunk of req) raw += chunk
    reply(200, await route(raw ? JSON.parse(raw) : {}, url))
  } catch (error) {
    reply(500, { error: String(error.message ?? error) })
  }
})

rmSync(socketPath, { force: true })
httpServer.listen(socketPath, () => {
  chmodSync(socketPath, 0o600)
  emit({ type: 'ready', device: publicDevice() })
})
const cleanup = () => {
  rmSync(socketPath, { force: true })
  dropReviewLock()
  process.exit(0)
}
process.on('SIGTERM', cleanup)
process.on('SIGINT', cleanup)
// The plugin holds our stdout; when it goes away, so do we.
process.stdout.on('error', cleanup)

// --- the channels' WebSockets ---------------------------------------------------------

// channel id -> { ws, url, token, delay, retry }
const sockets = new Map()

function openSocket(channel, url, token) {
  closeSocket(channel)
  const target = { url, token, delay: 1000 }
  sockets.set(channel, target)
  connectSocket(channel, target)
}

function closeSocket(channel) {
  const target = sockets.get(channel)
  if (!target) return
  sockets.delete(channel)
  clearTimeout(target.retry)
  target.ws?.close()
}

function connectSocket(channel, target) {
  if (sockets.get(channel) !== target) return
  // The token rides as the subprotocol: WebSocket clients cannot set headers.
  const socket = new WebSocket(target.url, [target.token])
  target.ws = socket
  let ping
  socket.addEventListener('open', () => {
    target.delay = 1000
    emit({ type: 'status', state: 'open', channel })
    ping = setInterval(() => socket.send('ping'), 30_000)
  })
  socket.addEventListener('message', ({ data }) => {
    if (data === 'pong') return
    try {
      emit({ ...JSON.parse(String(data)), channel })
    } catch {
      // Not ours.
    }
  })
  socket.addEventListener('close', ({ code }) => {
    clearInterval(ping)
    if (sockets.get(channel) !== target || target.ws !== socket) return
    // The channel became encrypted and this connection has no device key yet: the
    // plugin registers one, then asks for the socket again.
    if (code === 4003) {
      sockets.delete(channel)
      emit({ type: 'status', state: 'device-required', channel })
      return
    }
    // 4001: disconnected; 4002: another session took this name; 4000: channel deleted.
    if (code === 4000 || code === 4001 || code === 4002) {
      sockets.delete(channel)
      emit({ type: 'status', state: 'revoked', code, channel })
      return
    }
    emit({ type: 'status', state: 'closed', channel })
    target.retry = setTimeout(() => connectSocket(channel, target), target.delay)
    target.delay = Math.min(target.delay * 2, 30_000)
  })
  socket.addEventListener('error', () => {
    // 'close' follows and schedules the retry.
  })
}
