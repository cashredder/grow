// Some NEAR wallet modules expect Node's Buffer and process. Imported first by lib/near.ts, so these exist
// before those modules run.
import { Buffer } from 'buffer'

const g = globalThis as { Buffer?: typeof Buffer; process?: { env: Record<string, string>; browser?: boolean } }
g.Buffer ??= Buffer
g.process ??= { env: {}, browser: true }
