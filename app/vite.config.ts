import { defineConfig, type Plugin } from 'vite'
import { writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

// Development only: lets /dev-banner save the images it draws next to the project.
const saveImages = (): Plugin => ({
  name: 'save-images',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/__save', (req, res) => {
      const name = basename(new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '')
      if (req.method !== 'POST' || !/^[\w@.-]+\.png$/.test(name)) { res.statusCode = 400; res.end(); return }
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        writeFileSync(resolve(__dirname, '..', name), Buffer.from(body.replace(/^data:image\/png;base64,/, ''), 'base64'))
        res.end('ok')
      })
    })
  },
})
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react(), saveImages()],
  // Some NEAR wallet modules expect Node's `global`.
  define: { global: 'globalThis' },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
})
