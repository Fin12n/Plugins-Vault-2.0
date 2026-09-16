import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Fastify serves this directory via @fastify/static.
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // Dev-only: proxy API calls to the Fastify process so the dashboard can run
    // on Vite's dev server without CORS.
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});

