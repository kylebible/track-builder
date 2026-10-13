import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works under GitHub Pages' /track-builder/ path.
  base: './',
  // three.js alone is about 600 kB; that's expected for this app.
  build: { chunkSizeWarningLimit: 1000 },
});
