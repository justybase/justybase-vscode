import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The workspace package is CommonJS for the API/desktop builds. Resolve
    // the shared source in the browser bundle so runtime contract helpers
    // (for example UnsupportedDesignerOperationError) remain tree-shakable
    // named exports instead of relying on Rollup's CJS guesser.
    alias: { '@justybase/contracts': path.join(repositoryRoot, 'packages/contracts/src') },
  },
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:3000', ws: true } } },
});
