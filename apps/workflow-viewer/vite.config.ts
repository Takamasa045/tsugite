import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // The CLI copies the build under dist/<run-id>/viewer and opens it as a local file.
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    // Keep verification stable when the managed worktree reuses a dependency symlink.
    preserveSymlinks: true,
    alias: {
      '@react-three/fiber': fileURLToPath(new URL('./node_modules/@react-three/fiber/dist/react-three-fiber.esm.js', import.meta.url)),
      '@react-three/drei': fileURLToPath(new URL('./node_modules/@react-three/drei/index.js', import.meta.url)),
      // The literal `*` in the primary checkout path confuses wildcard package
      // exports. Resolve Zustand's ESM entrypoints through the current symlink.
      'zustand/vanilla/shallow': fileURLToPath(new URL('./node_modules/zustand/esm/vanilla/shallow.mjs', import.meta.url)),
      'zustand/react/shallow': fileURLToPath(new URL('./node_modules/zustand/esm/react/shallow.mjs', import.meta.url)),
      'zustand/traditional': fileURLToPath(new URL('./node_modules/zustand/esm/traditional.mjs', import.meta.url)),
      'zustand/shallow': fileURLToPath(new URL('./node_modules/zustand/esm/shallow.mjs', import.meta.url)),
      'zustand/middleware': fileURLToPath(new URL('./node_modules/zustand/esm/middleware.mjs', import.meta.url)),
      'zustand/vanilla': fileURLToPath(new URL('./node_modules/zustand/esm/vanilla.mjs', import.meta.url)),
      'zustand/react': fileURLToPath(new URL('./node_modules/zustand/esm/react.mjs', import.meta.url)),
      zustand: fileURLToPath(new URL('./node_modules/zustand/esm/index.mjs', import.meta.url)),
    },
  },
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
    exclude: [
      '**/node_modules/**',
      '**/.git/**',
      '**/.cache/**',
      '**/dist/**',
      'tests/production-orchestration-browser.test.mjs',
    ],
    server: {
      // The shared primary dependency symlink contains a literal `*` in its
      // parent path. Inline the ESM renderer dependencies so Node never
      // interprets that path as a package-export glob.
      deps: {
        inline: ['@react-three/fiber', '@react-three/drei', 'zustand'],
      },
    },
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
