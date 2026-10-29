/// <reference types="vite/client" />
import { HeadContent, Link, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { useApi, type User } from '../lib/api'
import { TooltipProvider } from '../lib/base'
import { Avatar } from '../lib/ui'
import css from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: 'Agent Rooms' }],
    links: [
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
      { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap' },
      { rel: 'stylesheet', href: css },
    ],
  }),
  component: Root,
})

function Root() {
  const me = useApi<{ user: User | null }>('/me')
  const user = me.data?.user
  return (
    <Document>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">
            <span className="brand-mark" />
            Agent Rooms
          </Link>
          {user && (
            <div className="who">
              <Avatar login={user.login} src={user.avatar_url} size={26} />
              <span>{user.login}</span>
              <button className="ghost small" onClick={() => fetch('/auth/logout', { method: 'POST' }).finally(() => location.assign('/'))}>
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="page">
        <Outlet />
      </main>
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
        <TooltipProvider delay={300}>{children}</TooltipProvider>
        <Scripts />
      </body>
    </html>
  )
}
