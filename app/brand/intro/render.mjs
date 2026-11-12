// Renders intro.html frame by frame through headless Chrome, then encodes it with ffmpeg.
// usage: node render.mjs <ffmpeg> <out.mp4> [audio.wav]         full video
//        node render.mjs <ffmpeg> <dir> --stills t1,t2,...      preview images
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [ffmpeg, out, third, fourth] = process.argv.slice(2)
const here = dirname(fileURLToPath(import.meta.url))
const svg = readFileSync(join(here, '..', 'grow-logo.svg'), 'utf8')
const logoD = svg.match(/ d="([^"]+)"/)[1]
const FPS = 30
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const port = 9333

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'grow-'))}`, '--window-size=1920,1080', '--allow-file-access-from-files', '--no-first-run', pathToFileURL(join(here, 'intro.html')).href], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let target
for (let i = 0; i < 60 && !target; i++) { await sleep(500); try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); target = l.find((x) => x.type === 'page' && x.url.includes('intro.html')) } catch { /* not up yet */ } }
if (!target) { chrome.kill(); throw new Error('Chrome did not start') }
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => { ws.onopen = r })
let id = 0
const pending = new Map()
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) } }
const evalJs = (expression) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => { const r = d.result; if (d.error || r?.exceptionDetails) rej(new Error(JSON.stringify(d.error || r.exceptionDetails))); else res(r.result.value) }); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })) })

await sleep(500)
const fontData = readFileSync(join(here, '..', 'grow-app/node_modules/@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2')).toString('base64')
await evalJs(`window.LOGO_D=${JSON.stringify(logoD)};(async()=>{const f=new FontFace('Sans','url(data:font/woff2;base64,${fontData})',{weight:'400 700'});await f.load();document.fonts.add(f);return 1})()`)
const total = await evalJs('INTRO.total')
const cuts = await evalJs('JSON.stringify(INTRO.cuts)')
console.log('duration', total, 'cuts', cuts)
writeFileSync(join(here, 'cuts.json'), cuts)

if (third === '--stills') {
  mkdirSync(out, { recursive: true })
  for (const t of fourth.split(',')) writeFileSync(join(out, `t${(+t).toFixed(2)}.jpg`), Buffer.from(await evalJs(`INTRO.frame(${t},.85)`), 'base64'))
} else {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', 'pipe:0']
  if (third) args.push('-i', resolve(third))
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart')
  if (third) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest')
  args.push(resolve(out))
  const ff = spawn(ffmpeg, args, { stdio: ['pipe', 'inherit', 'inherit'] })
  const n = Math.round(total * FPS)
  for (let f = 0; f < n; f++) {
    const buf = Buffer.from(await evalJs(`INTRO.frame(${f / FPS})`), 'base64')
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r))
    if (f % 60 === 0) console.log(`frame ${f}/${n}`)
  }
  ff.stdin.end()
  await new Promise((r) => ff.on('close', r))
  console.log('done', out)
}
ws.close(); chrome.kill(); process.exit(0)
