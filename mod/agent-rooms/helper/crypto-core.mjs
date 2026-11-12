// End-to-end encryption for Agent Rooms, shared by the plugin's helper (Node)
// and the website (browser). Only WebCrypto is used, so both run it as is.
//
// A device has an Ed25519 key (signs what it sends) and an X25519 key
// (receives message keys). Its id is a hash of both public keys, so an id
// can never be paired with other keys.
//
// A message is encrypted once with a fresh AES-GCM key. That key is wrapped
// for each recipient device through an ephemeral X25519 exchange, and the
// whole envelope is signed by the sender's device. A device can read only
// messages whose sender chose to wrap the key for it.

const subtle = globalThis.crypto.subtle
const enc = new TextEncoder()
const dec = new TextDecoder()

const ED25519_PKCS8 = 'MC4CAQAwBQYDK2VwBCIEIA=='
const X25519_PKCS8 = 'MC4CAQAwBQYDK2VuBCIEIA=='

export const b64 = bytes => {
  let s = ''
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export const unb64 = text => {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4))
  return Uint8Array.from(s, c => c.charCodeAt(0))
}
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) out.set(p, at), (at += p.length)
  return out
}

async function hex(bytes) {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// --- device keys --------------------------------------------------------------

export async function generateDevice() {
  const sign = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const box = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
  return exportDevice(sign.privateKey, box.privateKey)
}

// The same keys every time from the same 32+32 bytes (a passkey's PRF output).
export async function deviceFromSeeds(signSeed, boxSeed) {
  const pkcs8 = (header, seed) => concat(unb64(header).slice(0, 16), seed)
  const sign = await subtle.importKey('pkcs8', pkcs8(ED25519_PKCS8, signSeed), { name: 'Ed25519' }, true, ['sign'])
  const box = await subtle.importKey('pkcs8', pkcs8(X25519_PKCS8, boxSeed), { name: 'X25519' }, true, ['deriveBits'])
  return exportDevice(sign, box)
}

async function exportDevice(signPriv, boxPriv) {
  const signJwk = await subtle.exportKey('jwk', signPriv)
  const boxJwk = await subtle.exportKey('jwk', boxPriv)
  const signPub = signJwk.x
  const encPub = boxJwk.x
  return { id: await deviceId(signPub, encPub), signPub, encPub, signPriv: signJwk.d, encPriv: boxJwk.d }
}

export async function deviceId(signPub, encPub) {
  const digest = await subtle.digest('SHA-256', concat(enc.encode('agent-rooms device v1'), unb64(signPub), unb64(encPub)))
  return (await hex(digest)).slice(0, 32)
}

// `7F3A 91C2 0B4E …`: what two people compare to know they have the same key.
export const formatFingerprint = id => id.toUpperCase().match(/.{4}/g).slice(0, 6).join(' ')

const importSignPriv = (d, x) => subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', d, x }, { name: 'Ed25519' }, false, ['sign'])
const importSignPub = x => subtle.importKey('raw', unb64(x), { name: 'Ed25519' }, false, ['verify'])
const importBoxPriv = (d, x) => subtle.importKey('jwk', { kty: 'OKP', crv: 'X25519', d, x }, { name: 'X25519' }, false, ['deriveBits'])
const importBoxPub = x => subtle.importKey('raw', unb64(x), { name: 'X25519' }, false, [])

async function wrapKeyFor(ephPriv, ephPub, recipient) {
  const shared = await subtle.deriveBits({ name: 'X25519', public: await importBoxPub(recipient.encPub) }, ephPriv, 256)
  const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: unb64(ephPub), info: enc.encode(`agent-rooms wrap v1 ${recipient.id}`) },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function signedBytes(envelope, channelId) {
  const keys = envelope.keys.map(k => `${k.to}:${k.iv}:${k.wk}`).join(',')
  return enc.encode(['agent-rooms msg v1', channelId, envelope.from, envelope.eph, envelope.iv, envelope.ct, keys].join('|'))
}

// --- messages -------------------------------------------------------------------

// `payload` is any JSON value; `recipients` are the devices allowed to read it.
export async function seal({ channelId, sender, recipients, payload }) {
  const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt'])
  const raw = new Uint8Array(await subtle.exportKey('raw', key))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(channelId) }, key, enc.encode(JSON.stringify(payload)))

  const eph = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
  const ephPub = b64(await subtle.exportKey('raw', eph.publicKey))
  const unique = [...new Map(recipients.map(r => [r.id, r])).values()]
  const keys = await Promise.all(
    unique.map(async r => {
      const wrapIv = crypto.getRandomValues(new Uint8Array(12))
      const wk = await subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, await wrapKeyFor(eph.privateKey, ephPub, r), raw)
      return { to: r.id, iv: b64(wrapIv), wk: b64(wk) }
    }),
  )

  const envelope = { v: 1, from: sender.id, eph: ephPub, iv: b64(iv), ct: b64(ct), keys }
  const sig = await subtle.sign({ name: 'Ed25519' }, await importSignPriv(sender.signPriv, sender.signPub), signedBytes(envelope, channelId))
  return { ...envelope, sig: b64(sig) }
}

// Verifies the sender's signature, then decrypts. Throws when the envelope is
// not addressed to `me`, was altered, or was not signed by `senderSignPub`.
export async function open({ channelId, envelope, me, senderSignPub }) {
  if (envelope.v !== 1) throw new Error('unknown envelope version')
  const ok = await subtle.verify({ name: 'Ed25519' }, await importSignPub(senderSignPub), unb64(envelope.sig), signedBytes(envelope, channelId))
  if (!ok) throw new Error('bad signature')
  const mine = envelope.keys.find(k => k.to === me.id)
  if (!mine) throw Object.assign(new Error('not addressed to this device'), { code: 'not-for-me' })

  const shared = await subtle.deriveBits({ name: 'X25519', public: await importBoxPub(envelope.eph) }, await importBoxPriv(me.encPriv, me.encPub), 256)
  const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  const wrapKey = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: unb64(envelope.eph), info: enc.encode(`agent-rooms wrap v1 ${me.id}`) },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  )
  const raw = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(mine.iv) }, wrapKey, unb64(mine.wk))
  const key = await subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv), additionalData: enc.encode(channelId) }, key, unb64(envelope.ct))
  return JSON.parse(dec.decode(plain))
}

// --- files ------------------------------------------------------------------------

// Files are encrypted with their own key, which travels inside the message.
export async function encryptFile(bytes) {
  const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes))
  return { ct, key: b64(await subtle.exportKey('raw', key)), iv: b64(iv) }
}

export async function decryptFile(ct, { key, iv }) {
  const k = await subtle.importKey('raw', unb64(key), 'AES-GCM', false, ['decrypt'])
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, k, ct))
}

// Files over 10 MB go in pieces of FILE_CHUNK bytes, each encrypted on its
// own under the file's key. A piece's nonce and associated data carry its
// index and whether it is the last, so pieces can't be reordered, swapped
// or cut off without failing to decrypt.
export const FILE_CHUNK = 8 * 1024 * 1024

export async function newFileKey() {
  const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  return { key: b64(await subtle.exportKey('raw', key)), iv: b64(crypto.getRandomValues(new Uint8Array(12))) }
}

function chunkParams(iv, index, last) {
  const nonce = unb64(iv)
  const view = new DataView(nonce.buffer)
  view.setUint32(8, view.getUint32(8) ^ index)
  const aad = new Uint8Array(5)
  new DataView(aad.buffer).setUint32(0, index)
  aad[4] = last ? 1 : 0
  return { name: 'AES-GCM', iv: nonce, additionalData: aad }
}

export async function encryptChunk({ key, iv }, index, last, bytes) {
  const k = await subtle.importKey('raw', unb64(key), 'AES-GCM', false, ['encrypt'])
  return new Uint8Array(await subtle.encrypt(chunkParams(iv, index, last), k, bytes))
}

export async function decryptChunk({ key, iv }, index, last, ct) {
  const k = await subtle.importKey('raw', unb64(key), 'AES-GCM', false, ['decrypt'])
  return new Uint8Array(await subtle.decrypt(chunkParams(iv, index, last), k, ct))
}

// How many pieces a file of `size` bytes has, and each one's length when encrypted (16 bytes of tag each).
export const chunkCount = size => Math.max(1, Math.ceil(size / FILE_CHUNK))
export const sealedChunkLength = (size, index) => Math.min(FILE_CHUNK, size - index * FILE_CHUNK) + 16
// Where piece `index` sits in the stored file, encrypted or not.
export const storedRange = (size, index, sealed) =>
  sealed ? { offset: index * (FILE_CHUNK + 16), length: sealedChunkLength(size, index) } : { offset: index * FILE_CHUNK, length: Math.min(FILE_CHUNK, size - index * FILE_CHUNK) }

// Runs fn(0..count-1) for a file's pieces, as many at once as the network
// keeps up with: it starts at 8 and allows a quarter more each round that
// finishes pieces faster than any round before, up to `max` (each piece in
// flight holds up to 16 MB). A piece that fails is retried up to 3 times, halving how many
// run at once; a fourth failure fails the whole.
export function inParallel(count, fn, { start = 8, max = 32, retries = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let limit = Math.min(start, max)
    let next = 0
    let running = 0
    let done = 0
    let failed = false
    let best = 0
    let round = { at: Date.now(), done: 0 }
    const tries = new Map()
    const queue = []
    const finished = () => {
      done++
      round.done++
      // Pieces are the same size, so pieces per millisecond is the speed.
      if (round.done >= limit) {
        const speed = round.done / Math.max(1, Date.now() - round.at)
        if (speed > best * 1.05) limit = Math.min(max, limit + Math.max(1, Math.floor(limit / 4)))
        best = Math.max(best, speed)
        round = { at: Date.now(), done: 0 }
      }
    }
    const launch = () => {
      while (!failed && running < limit && (queue.length || next < count)) {
        const i = queue.length ? queue.shift() : next++
        running++
        fn(i).then(
          () => {
            running--
            finished()
            if (done === count) resolve()
            else launch()
          },
          error => {
            running--
            const tried = (tries.get(i) ?? 0) + 1
            tries.set(i, tried)
            if (tried > retries) {
              failed = true
              return reject(error)
            }
            limit = Math.max(1, Math.floor(limit / 2))
            queue.push(i)
            setTimeout(launch, 500 * tried)
          },
        )
      }
    }
    if (count === 0) resolve()
    else launch()
  })
}

// --- trust lists ---------------------------------------------------------------

// A device's decisions about other devices, encrypted under a key only it
// holds (the browser keeps its list on the server this way).
export async function encryptState(state, secret) {
  const key = await subtle.importKey('raw', secret, 'AES-GCM', false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(state)))
  return `${b64(iv)}.${b64(ct)}`
}

export async function decryptState(blob, secret) {
  const [iv, ct] = blob.split('.')
  const key = await subtle.importKey('raw', secret, 'AES-GCM', false, ['decrypt'])
  return JSON.parse(dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct))))
}
