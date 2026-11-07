import { defineConfig } from 'vitest/config'

// Only for scripts/seed-local.ts; the normal test run never seeds anything.
export default defineConfig({ test: { include: ['scripts/seed-local.ts'] } })
