import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev the app talks to the executor through /api so the browser never needs CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.GIVEN_API ?? 'http://127.0.0.1:8787', rewrite: (p) => p.replace(/^\/api/, '') } },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
