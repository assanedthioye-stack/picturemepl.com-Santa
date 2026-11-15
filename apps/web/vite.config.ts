import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Preact (React-compatible, ~4 KB) keeps the app light on prepaid mobile data.
export default defineConfig({
  plugins: [preact(), tailwindcss()],
  build: { target: 'es2020' },
});
