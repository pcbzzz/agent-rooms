// The browser as an end-to-end encrypted device. Its keys come from a passkey
// (the WebAuthn PRF extension), so the same passkey is the same device on any
// browser it syncs to; keys never leave memory. Browsers without PRF get a
// device kept in this browser's storage instead.

import * as core from '../../../mod/agent-rooms/helper/crypto-core.mjs'
import { api } from './api'

export type BrowserDevice = core.Device & { kind: 'passkey' | 'local'; stateKey?: core.Bytes }
export type Decision = { decision: 'approved' | 'denied'; signPub: string; encPub: string; login: string; label: string; at: number }
export type ChannelDevice = { id: string; kind: 'cli' | 'browser'; label: string; signPub: string; encPub: string; login: string; sessions: string[]; isOnline: boolean }
// A message's content; attachments carry a key in encrypted channels only.
// `chunk`: sent in pieces of that size, each encrypted on its own (files over 10 MB).
// `expires`: when the server deletes the file.
export type Payload = { text: string; files?: { id: string; name: string; type: string; size: number; key?: string; iv?: string; chunk?: number; expires?: number }[] }

const PASSKEY = 'agent-rooms:passkey'
const LOCAL_DEVICE = 'agent-rooms:local-device'
const LOCAL_TRUST = 'agent-rooms:local-trust'
const SALT = new TextEncoder().encode('agent-rooms device v1')

let unlocked: BrowserDevice | undefined
let trust: Record<string, Decision> = {}

export const current = () => unlocked
export const trustList = () => trust
export const fingerprint = core.formatFingerprint
export const hasPasskey = () => !!safeGet(PASSKEY) || !!safeGet(LOCAL_DEVICE)

function safeGet(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private mode: the device lasts this page only.
  }
}

async function hkdf(secret: core.Bytes, info: string): Promise<core.Bytes> {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: new TextEncoder().encode(info) }, key, 256))
}

async function fromSecret(secret: core.Bytes): Promise<BrowserDevice> {
  const device = await core.deviceFromSeeds(await hkdf(secret, 'sign'), await hkdf(secret, 'box'))
  return { ...device, kind: 'passkey', stateKey: await hkdf(secret, 'state') }
}

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } }

// Unlocks this browser's device with a passkey: the one it used before, or
// any synced to it from another device (so a passkey made on a Mac is the
// same device on the iPhone it syncs to). `create` makes a new passkey
// instead, a new device. Must run from a click: browsers only show passkey
// prompts for one.
export async function unlock(user: { id: string; login: string }, create = false): Promise<BrowserDevice> {
  if (unlocked) return unlocked
  const local = safeGet(LOCAL_DEVICE)
  if (local && !safeGet(PASSKEY) && !create) return finish(user, { ...(JSON.parse(local) as core.Device), kind: 'local' })

  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const saved = safeGet(PASSKEY)
  let secret: ArrayBuffer | undefined
  let credentialId = saved && !create ? core.unb64(saved) : undefined

  if (create) {
    const created = (await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'Agent Rooms', id: location.hostname },
        // A fresh handle each time: one made with the same handle would replace a synced passkey, and with it that device.
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: user.login, displayName: `${user.login} · Agent Rooms` },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        extensions: { prf: { eval: { first: SALT } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null
    if (!created) throw new Error('Passkey setup was cancelled.')
    const prf = (created.getClientExtensionResults() as PrfResults).prf
    if (!prf?.enabled) return setUpLocal(user)
    credentialId = new Uint8Array(created.rawId)
    safeSet(PASSKEY, core.b64(credentialId))
    secret = prf.results?.first
  }

  if (!secret) {
    // With no credential named, the browser offers every passkey it has for this site, synced ones included.
    const got = (await navigator.credentials
      .get({
        publicKey: {
          challenge,
          rpId: location.hostname,
          allowCredentials: credentialId ? [{ type: 'public-key', id: credentialId }] : [],
          userVerification: 'required',
          extensions: { prf: { eval: { first: SALT } } } as AuthenticationExtensionsClientInputs,
        },
      })
      .catch((error: Error) => {
        if (error.name === 'NotAllowedError' && !credentialId) throw new Error('No passkey was picked. If this device has none for Agent Rooms yet, create one.')
        throw error
      })) as PublicKeyCredential | null
    if (got && !credentialId) safeSet(PASSKEY, core.b64(new Uint8Array(got.rawId)))
    secret = (got?.getClientExtensionResults() as PrfResults | undefined)?.prf?.results?.first
    if (!secret) throw new Error("This passkey can't unlock encryption here. Try a browser with passkey PRF support (recent Chrome, Safari or Edge).")
  }
  return finish(user, await fromSecret(new Uint8Array(secret)))
}

// No passkey PRF: a device kept in this browser's storage.
async function setUpLocal(user: { id: string; login: string }) {
  const device = await core.generateDevice()
  safeSet(LOCAL_DEVICE, JSON.stringify(device))
  return finish(user, { ...device, kind: 'local' })
}

async function finish(_user: { id: string; login: string }, device: BrowserDevice) {
  await api('/devices', { method: 'POST', body: { id: device.id, signPub: device.signPub, encPub: device.encPub, label: 'Browser' } })
  unlocked = device
  await loadTrust()
  return device
}

// --- this browser's decisions about other devices ------------------------------------

// Keyed by device: a decision holds in every channel. Earlier ones were kept
// per channel (`<channel>:<device>`); the latest for each device wins.
async function loadTrust() {
  if (!unlocked) return
  let saved: Record<string, Decision>
  if (unlocked.stateKey) {
    const { state } = await api<{ state: string | null }>(`/devices/${unlocked.id}/state`)
    saved = state ? await core.decryptState<Record<string, Decision>>(state, unlocked.stateKey) : {}
  } else {
    saved = JSON.parse(safeGet(LOCAL_TRUST) ?? '{}')
  }
  trust = {}
  for (const [key, d] of Object.entries(saved)) {
    const id = key.slice(key.indexOf(':') + 1)
    if (!trust[id] || trust[id].at < d.at) trust[id] = d
  }
}

// 'undecided' takes a decision back.
export async function decide(device: ChannelDevice, decision: Decision['decision'] | 'undecided') {
  if (!unlocked) throw new Error('Unlock first.')
  await loadTrust()
  const { [device.id]: _, ...rest } = trust
  trust = decision === 'undecided' ? rest : { ...rest, [device.id]: { decision, signPub: device.signPub, encPub: device.encPub, login: device.login, label: device.label, at: Date.now() } }
  if (unlocked.stateKey) await api(`/devices/${unlocked.id}/state`, { method: 'PUT', body: { state: await core.encryptState(trust, unlocked.stateKey) } })
  else safeSet(LOCAL_TRUST, JSON.stringify(trust))
}

export const decisionFor = (deviceId: string) => trust[deviceId]

// --- messages and files -------------------------------------------------------------

export type Opened =
  | { status: 'ok'; payload: Payload; plain?: true }
  | { status: 'locked' | 'not-for-me' | 'unapproved' | 'invalid' | 'plain'; device?: string; text?: string }

export async function openMessage(channelId: string, text: string): Promise<Opened> {
  let envelope: core.Envelope
  try {
    const parsed = JSON.parse(text) as { v?: number }
    // A plain channel's message.
    if (parsed?.v === 0) return { status: 'ok', payload: parsed as Payload, plain: true }
    if (parsed?.v !== 1) throw new Error()
    envelope = parsed as core.Envelope
  } catch {
    return { status: 'plain', text }
  }
  if (!unlocked) return { status: 'locked' }
  const sender = envelope.from === unlocked.id ? unlocked : decisionFor(envelope.from)
  if (!sender || ('decision' in sender && sender.decision !== 'approved')) return { status: 'unapproved', device: envelope.from }
  try {
    return { status: 'ok', payload: await core.open<Payload>({ channelId, envelope, me: unlocked, senderSignPub: sender.signPub }) }
  } catch (error) {
    return { status: (error as { code?: string }).code === 'not-for-me' ? 'not-for-me' : 'invalid' }
  }
}

// Up to this, a file goes up in one request; bigger ones (which the server allows some accounts only) in parts.
export const ONE_REQUEST = 10 * 1024 * 1024
// A phone can't hold 32 pieces of 16 MB in memory at once.
const BROWSER_PARALLEL = { max: 16 }

async function send<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init })
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Upload failed.')
  return (await res.json()) as T
}

// Uploads a file, encrypted unless `encrypt` is false, kept `keep` seconds (a
// week at most): whole up to 10 MB (which older plugins read too), in
// FILE_CHUNK pieces past that.
async function uploadFile(channelId: string, file: File, encrypt: boolean, keep: number) {
  const meta = { name: file.name, type: file.type || 'application/octet-stream', size: file.size }
  if (file.size <= ONE_REQUEST) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const sealed = encrypt ? await core.encryptFile(bytes) : undefined
    const { id, expires } = await send<{ id: string; expires: number }>(`/api/channels/${channelId}/files?keep=${keep}`, { method: 'POST', body: sealed?.ct ?? bytes })
    return { id, ...meta, expires, ...(sealed ? { key: sealed.key, iv: sealed.iv } : {}) }
  }
  const fileKey = encrypt ? await core.newFileKey() : undefined
  const { id, uploadId } = await send<{ id: string; uploadId: string }>(`/api/channels/${channelId}/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ size: file.size, keep }),
  })
  const count = core.chunkCount(file.size)
  const parts: { part: number; etag: string }[] = new Array(count)
  await core.inParallel(count, async i => {
    const piece = new Uint8Array(await file.slice(i * core.FILE_CHUNK, (i + 1) * core.FILE_CHUNK).arrayBuffer())
    const body = fileKey ? await core.encryptChunk(fileKey, i, i === count - 1, piece) : piece
    parts[i] = await send(`/api/channels/${channelId}/uploads/${id}/${i + 1}?uploadId=${encodeURIComponent(uploadId)}`, { method: 'PUT', body })
  }, BROWSER_PARALLEL)
  const { expires } = await send<{ expires: number }>(`/api/channels/${channelId}/uploads/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId, parts }),
  })
  return { id, ...meta, expires, ...(fileKey ? { ...fileKey, chunk: core.FILE_CHUNK } : {}) }
}

// A plain channel's attachments go up as they are.
export async function uploadPlain(channelId: string, files: File[], keep: number) {
  return Promise.all(files.map(file => uploadFile(channelId, file, false, keep)))
}

export async function sealMessage(channelId: string, recipients: ChannelDevice[], text: string, files: File[], keep: number) {
  if (!unlocked) throw new Error('Unlock first.')
  const uploaded = await Promise.all(files.map(file => uploadFile(channelId, file, true, keep)))
  const envelope = await core.seal({ channelId, sender: unlocked, recipients: [unlocked, ...recipients], payload: { text, files: uploaded } })
  return { envelope, device: unlocked.id }
}

const fileCache = new Map<string, Promise<string>>()

// Fetches an attachment and decrypts it; one over 10 MB comes down in pieces, several at once.
async function fetchFile(channelId: string, file: NonNullable<Payload['files']>[number]): Promise<core.Bytes[]> {
  const url = `/api/channels/${channelId}/files/${file.id}`
  const fileKey = file.key && file.iv ? { key: file.key, iv: file.iv } : undefined
  if (!file.chunk && (fileKey || file.size <= ONE_REQUEST)) {
    const res = await fetch(url, { credentials: 'same-origin' })
    if (!res.ok) throw new Error('missing')
    const raw = new Uint8Array(await res.arrayBuffer())
    return [fileKey ? await core.decryptFile(raw, fileKey) : raw]
  }
  const count = core.chunkCount(file.size)
  const parts: core.Bytes[] = new Array(count)
  await core.inParallel(count, async i => {
    const { offset, length } = core.storedRange(file.size, i, !!fileKey)
    const res = await fetch(url, { credentials: 'same-origin', headers: { Range: `bytes=${offset}-${offset + length - 1}` } })
    const piece = new Uint8Array(await res.arrayBuffer())
    if (res.status !== 206 || piece.length !== length) throw new Error('incomplete')
    parts[i] = fileKey ? await core.decryptChunk(fileKey, i, i === count - 1, piece) : piece
  }, BROWSER_PARALLEL)
  return parts
}

// A decrypted attachment as an object URL, fetched once.
export function fileUrl(channelId: string, file: NonNullable<Payload['files']>[number]) {
  let url = fileCache.get(file.id)
  if (!url) {
    url = fetchFile(channelId, file).then(parts => URL.createObjectURL(new Blob(parts, { type: file.type })))
    fileCache.set(file.id, url)
  }
  return url
}
