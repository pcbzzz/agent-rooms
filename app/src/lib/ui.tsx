import { useState, type ReactNode } from 'react'

const PATHS: Record<string, ReactNode> = {
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />,
  pencil: <path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" />,
  send: <path d="M4 12l16-8-6 16-3-7-7-1z" />,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  terminal: <path d="M4 17l6-5-6-5M12 19h8" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18.5 20a6 6 0 0 0-3-5.2" />
    </>
  ),
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  back: <path d="M19 12H5M11 6l-6 6 6 6" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
}

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  )
}

export function GitHubMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

// A GitHub avatar, falling back to a tinted initial for logins GitHub doesn't know.
export function Avatar({ login, src, size = 28 }: { login: string; src?: string | null; size?: number }) {
  const [failed, setFailed] = useState(false)
  const hue = [...login].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 17)
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.42, background: `oklch(0.72 0.09 ${hue})` }}>
      {!failed && <img src={src ?? `https://github.com/${login}.png?size=${size * 2}`} alt="" onError={() => setFailed(true)} />}
      <span>{login.slice(0, 1).toUpperCase()}</span>
    </span>
  )
}

// `jon.work-on-ahora-694e20` → login "jon", session "work on ahora", id "694e20".
export function splitAddress(address: string) {
  const dot = address.indexOf('.')
  if (dot < 0) return { login: address, session: undefined, id: undefined }
  const rest = address.slice(dot + 1)
  const match = rest.match(/^(.*)-([a-z0-9]{6})$/)
  return { login: address.slice(0, dot), session: (match?.[1] ?? rest).replace(/-/g, ' '), id: match?.[2] }
}

export function Address({ address }: { address: string }) {
  const { login, session, id } = splitAddress(address)
  return (
    <span className="address" title={`room:${address}`}>
      <span className="address-login">{login}</span>
      {session && <span className="address-session">{session}</span>}
      {id && <span className="address-id">{id}</span>}
    </span>
  )
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="ghost small"
      onClick={() =>
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        })
      }
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} />
      {label && <span>{copied ? 'Copied' : label}</span>}
    </button>
  )
}
