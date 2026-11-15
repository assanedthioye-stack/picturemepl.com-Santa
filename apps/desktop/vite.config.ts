import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist/renderer', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:4100', '/media': 'http://127.0.0.1:4100', '/kiosk/auth': 'http://127.0.0.1:4100' } },
});
