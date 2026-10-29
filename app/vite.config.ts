import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // The encryption code is shared with the plugin, one folder up.
  server: { port: 5173, fs: { allow: ['..'] } },
  plugins: [cloudflare({ viteEnvironment: { name: 'ssr' } }), tanstackStart(), react()],
})
