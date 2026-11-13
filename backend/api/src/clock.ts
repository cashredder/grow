// Two Durable Objects.
//
// Clock: one instance whose alarm runs every CLOCK_EVERY_MS (2 s). Alarms of one object never overlap, so the
// indexer cursor and the relayer's nonces are only ever touched by one run at a time (Spark's KeeperClock).
// Each tick indexes new blocks; agents and copies run every few ticks; the keeper about once a minute.
//
// Hub: the live feed. Browsers connect to /v1/stream (WebSocket, hibernating), the clock posts new events.
import type { Env } from './env'
import { fanOutCopies, runAgents, runKeeper } from './agents/runner'
import { runIndexer, setState } from './indexer/run'
import { processJobs } from './lib/jobs'

export class Clock {
  private ticks = 0
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req?: Request): Promise<Response> {
    // Which NEAR AI key this clock instance holds (first characters only), to spot an instance with stale settings.
    if (req && new URL(req.url).pathname === '/key') {
      const k = (this.env.NEARAI_KEY || '').trim()
      return new Response(k ? `${k.slice(0, 4)}… (${k.length})` : 'none')
    }
    if ((await this.state.storage.getAlarm()) == null) await this.state.storage.setAlarm(Date.now() + 100)
    return new Response('wound')
  }

  async alarm(): Promise<void> {
    const every = Math.max(1000, Number(this.env.CLOCK_EVERY_MS || 2000))
    const env = this.env
    this.ticks++
    try {
      const r = await runIndexer(env)
      if (r.feed.length) {
        await fanOutCopies(env, r.feed.filter((f) => f.type === 'vault_trade').map((f) => f.data as { vault_id: number; seq: number; copied: boolean; side: string; token_id: string })).catch((e) => log(env, 'copies', e))
        await env.HUB.get(env.HUB.idFromName('hub')).fetch('https://hub/publish', { method: 'POST', body: JSON.stringify(r.feed) }).catch(() => {})
      }
      if (this.ticks % 5 === 0) await runAgents(env).catch((e) => log(env, 'agents', e))
      if (this.ticks % 30 === 0) await runKeeper(env).catch((e) => log(env, 'keeper', e))
      await processJobs(env).catch((e) => log(env, 'jobs', e))
    } catch (e) {
      await log(env, 'indexer', e)
    } finally {
      await this.state.storage.setAlarm(Date.now() + every)
    }
  }
}

async function log(env: Env, where: string, e: unknown) {
  await setState(env, `error:${where}`, `${new Date().toISOString()} ${String((e as Error)?.message || e).slice(0, 400)}`).catch(() => {})
}

export class Hub {
  constructor(private state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/publish' && req.method === 'POST') {
      const msg = await req.text()
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.send(msg)
        } catch {
          // closed meanwhile
        }
      }
      return new Response('ok')
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket', { status: 426 })
    if (this.state.getWebSockets().length > 5_000) return new Response('too many connections', { status: 503 })
    const pair = new WebSocketPair()
    this.state.acceptWebSocket(pair[1])
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    if (msg === 'ping') ws.send('pong')
  }

  webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code, 'bye')
    } catch {
      // already closed
    }
  }
}
