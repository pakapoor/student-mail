import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // shared/ (repo root) holds code used by both frontend and backend, e.g.
  // shared/edugate.ts - let the dev server read files from the repo root.
  server: { fs: { allow: ['..'] } },
})
