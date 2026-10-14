import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1", // pin to IPv4 — Vite defaults to IPv6-only (::1), which the
    // backend (uvicorn --host 127.0.0.1) and launch scripts don't match
    port: 5180,
    strictPort: true,
  },
})
