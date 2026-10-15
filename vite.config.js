import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    rollupOptions: { input: fileURLToPath(new URL('./demo/index.html', import.meta.url)) },
  },
  worker: { format: 'es' },
});
