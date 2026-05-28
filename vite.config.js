import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: 'hidden',
    rollupOptions: {
      output: {
        // Split React/runtime out into its own chunk so the initial app
        // bundle stays smaller and the heavier framework code can be
        // cached separately by Electron's chromium.
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'react';
        },
      },
    },
  },
});
