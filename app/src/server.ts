// The Worker: OAuthProvider guards /mcp and serves the OAuth endpoints;
// every other request goes to the Hono app, which hands what it does not
// route to TanStack Start.

import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import handler from '@tanstack/react-start/server-entry'

import { createApp } from './api/app'
import { mcpHandler } from './api/mcp'

export { Room } from './room'

const app = createApp(async request => handler.fetch(request))

// One per origin the Worker is reached at (its workers.dev host, a custom
// domain), so each advertises itself as the MCP resource; PUBLIC_URL pins one.
const providers = new Map<string, OAuthProvider<Env>>()

export default {
  fetch(request, env, ctx) {
    const base = (env.PUBLIC_URL || new URL(request.url).origin).replace(/\/+$/, '')
    let provider = providers.get(base)
    if (!provider) {
      provider = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: mcpHandler as never,
      defaultHandler: { fetch: (request, env, ctx) => app.fetch(request, env, ctx) },
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: ['channels'],
      resourceMetadata: { resource: `${base}/mcp`, authorization_servers: [base] },
      clientIdMetadataDocumentEnabled: true,
      })
      providers.set(base, provider)
    }
    return provider.fetch(request, env, ctx)
  },
} satisfies ExportedHandler<Env>
