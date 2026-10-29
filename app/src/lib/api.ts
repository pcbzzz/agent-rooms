import { useCallback, useEffect, useState } from 'react'

export type User = { id: string; login: string; name: string | null; avatar_url: string | null }
export type ChannelSummary = { id: string; name: string; role: 'owner' | 'member'; encrypted: number; member_count: number; connection_count: number; created_at: number }
export type ChannelDetail = {
  channel: { id: string; name: string; role: 'owner' | 'member'; owner_id: string; encrypted: number }
  members: (User & { role: string })[]
  connections: { id: string; member: string; login: string; isOnline: boolean; last_seen_at: number | null }[]
  invites: { code: string; max_uses: number | null; uses: number; expires_at: number | null }[]
}
export type Message = { seq: number; id: string; from: string; to: string | null; text: string; sentAt: number }

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? 'GET',
    headers: init?.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin',
  })
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
  return body
}

// Loads on mount and on reload(); data stays visible while reloading.
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!path) return
    let live = true
    api<T>(path).then(
      d => live && (setData(d), setError(undefined)),
      e => live && setError(String(e.message ?? e)),
    )
    return () => {
      live = false
    }
  }, [path, tick])
  return { data, error, reload: useCallback(() => setTick(t => t + 1), []) }
}

export function ago(at: number | null): string {
  if (!at) return 'never'
  const m = Math.round((Date.now() - at) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}
