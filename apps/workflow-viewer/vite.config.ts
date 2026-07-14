import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // The CLI copies the build under dist/<run-id>/viewer and opens it as a local file.
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    // Three.js stays behind a React lazy boundary, but the file:// artifact needs one JS file.
    chunkSizeWarningLimit: 1400,
    rolldownOptions: {
      // `pipeline viewer --open` loads a self-contained file:// artifact.
      output: { codeSplitting: false },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './tests/setup.ts',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/components/scene/**'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80
      }
    }
  }
})
