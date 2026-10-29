// The D1 schema, created on first use so a fresh deploy needs no migration
// step. Each statement is idempotent; it runs once per isolate.

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    github_id INTEGER UNIQUE,
    login TEXT NOT NULL UNIQUE,
    name TEXT,
    avatar_url TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS web_sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    encrypted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS channel_members (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    added_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    max_uses INTEGER,
    uses INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  // A one-time code a Claude Code session exchanges for its connection.
  `CREATE TABLE IF NOT EXISTS claims (
    hash TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  )`,
  // One connected Claude Code session; `member` is its name in the channel.
  `CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    token_hash TEXT UNIQUE,
    device_id TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    UNIQUE (channel_id, member)
  )`,
  // A key pair on one machine (cli) or browser; `state` is a browser's own encrypted approved list.
  `CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('cli', 'browser')),
    label TEXT NOT NULL,
    sign_pub TEXT NOT NULL,
    enc_pub TEXT NOT NULL,
    state TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS channel_devices (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, device_id)
  )`,
  `CREATE INDEX IF NOT EXISTS channel_members_user ON channel_members(user_id)`,
  `CREATE INDEX IF NOT EXISTS connections_user ON connections(user_id)`,
]

// Columns added after a table first shipped; adding one twice fails harmlessly.
const ADDED_COLUMNS = [`ALTER TABLE connections ADD COLUMN device_id TEXT`, `ALTER TABLE channels ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0`]

let ready: Promise<unknown> | undefined

export function ensureSchema(env: Env): Promise<unknown> {
  ready ??= env.DB.batch(STATEMENTS.map(sql => env.DB.prepare(sql)))
    .then(() => Promise.all(ADDED_COLUMNS.map(sql => env.DB.prepare(sql).run().catch(() => undefined))))
    .catch(error => {
      ready = undefined
      throw error
    })
  return ready
}
