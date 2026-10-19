import path from 'path'
import { defineConfig } from 'vitest/config'

// Unit tests for pure logic under src/ (formatting, state decisions, drafts).
// Component rendering is intentionally out of scope: keep decision logic in
// plain functions so it can be tested here without a DOM.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
})
