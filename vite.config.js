import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Targets set fairly low to accommodate older Tizen / webOS / Android-TV engines.
export default defineConfig({
  plugins: [react()],
  build: {
    target: ['es2018', 'chrome64', 'safari12'],
  },
  server: {
    host: true,
    port: 5173,
  },
});
