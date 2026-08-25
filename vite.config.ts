import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: 'panel.html',
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Matches server.ts's own PORT fallback — local `npm run dev` never loads .env
      // into process.env (no dotenv in this project), so this has to be a literal that
      // stays in sync with that fallback, not a read of an env var that won't be set.
      '/api': 'http://localhost:3003',
    },
  },
})
