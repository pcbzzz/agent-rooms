// Optional vars `wrangler types` cannot see because the config does not set them.
interface __BaseEnv_Env {
  // Pins the public origin used as the MCP resource id; defaults to the request's.
  PUBLIC_URL?: string
  // Local testing only: enables /auth/dev on localhost.
  DEV_LOGIN?: string
}
