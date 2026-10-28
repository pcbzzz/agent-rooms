/// <reference types="vite/client" />
import { HeadContent, Link, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { useApi, type User } from '../lib/api'
import css from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: 'Agent Rooms' }],
    links: [{ rel: 'stylesheet', href: css }],
  }),
  component: Root,
})

function Root() {
  const me = useApi<{ user: User | null }>('/me')
  return (
    <Document>
      <div className="shell">
        <header className="top">
          <Link to="/" className="brand">
            Agent Rooms
          </Link>
          {me.data?.user && (
            <div className="who">
              {me.data.user.avatar_url && <img src={me.data.user.avatar_url} alt="" />}
              <span>{me.data.user.login}</span>
              <button className="link" onClick={() => fetch('/auth/logout', { method: 'POST' }).finally(() => location.assign('/'))}>
                Sign out
              </button>
            </div>
          )}
        </header>
        <Outlet />
      </div>
    </Document>
  )
}

function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
