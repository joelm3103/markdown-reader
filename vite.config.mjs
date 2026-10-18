import { defineConfig } from 'vite'

// Renderer-only build. The main process (main.js / preload.js / src/fsapi.js /
// src/settings.js) stays plain CommonJS and is shipped as-is.
//
// root is src/ so the entry is src/index.html; the bundle lands in renderer/ so
// that electron-builder's own output (dist/) never collides with it.
// base './' keeps asset URLs relative, which is what the app:// protocol expects.
export default defineConfig({
  root: 'src',
  base: './',
  build: {
    outDir: '../renderer',
    emptyOutDir: true,
    target: 'esnext',
    sourcemap: false,
    chunkSizeWarningLimit: 1500
  }
})
