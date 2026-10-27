import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Builds the in-page demo (real client + in-memory backend) into one JS and one CSS file.
const root = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root,
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: 'dist-demo', emptyOutDir: true, cssCodeSplit: false, assetsInlineLimit: 100_000_000, target: 'es2022',
    rollupOptions: { input: join(root, 'demo.html'), output: { inlineDynamicImports: true, entryFileNames: 'demo.js', assetFileNames: 'demo[extname]' } },
  },
});
