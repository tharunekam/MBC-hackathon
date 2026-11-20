import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// This project's dev ports. They are fixed (strictPort) so the dev server fails loudly if something else holds
// one, instead of quietly moving to another port and talking to someone else's service.
//   web 5273   executor 8741   chain service 8742
const executor = process.env.GIVEN_API ?? 'http://127.0.0.1:8741';
const chain = process.env.GIVEN_CHAIN_API ?? 'http://127.0.0.1:8742';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': { target: executor, rewrite: (p) => p.replace(/^\/api/, '') },
      '/chain': { target: chain, rewrite: (p) => p.replace(/^\/chain/, '') },
    },
  },
  preview: { host: '127.0.0.1', port: 5273, strictPort: true },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
