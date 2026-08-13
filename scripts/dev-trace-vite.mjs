const TRACE_ENDPOINT = '/__l2chart_dev_trace'
const TRACE_VERSION = 1

const BROWSER_TRACE_SCRIPT = String.raw`
(() => {
  if (window.__L2CHART_DEV_TRACE_INSTALLED__) return
  window.__L2CHART_DEV_TRACE_INSTALLED__ = true

  const endpoint = '${TRACE_ENDPOINT}'
  const nativeFetch = window.fetch.bind(window)
  let sequence = 0

  const nextId = prefix => prefix + String(++sequence)
  const elapsed = started => Math.max(0, Math.round(performance.now() - started))

  const safeText = value => {
    if (value === null || value === undefined) return ''
    if (value instanceof Error) return value.message
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  const summarizeUrl = input => {
    try {
      const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url || ''
      const url = new URL(raw, location.href)
      for (const key of [...url.searchParams.keys()]) {
        if (/(token|key|secret|password|username|credential|authorization|auth)/i.test(key)) {
          url.searchParams.set(key, '[redacted]')
        }
      }
      return url.origin === location.origin
        ? url.pathname + url.search
        : url.origin + url.pathname + url.search
    } catch {
      return '[unparseable-url]'
    }
  }

  const report = event => {
    const payload = {
      page: location.pathname,
      at: Date.now(),
      ...event,
    }
    void nativeFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => undefined)
  }

  const shouldTraceUrl = url => {
    if (!url || url === endpoint) return false
    if (url.startsWith('/@vite') || url.startsWith('/__l2chart_dev_trace')) return false
    if (url === '/provider-runtime/health' || url === '/assistant-api/health') return false
    return true
  }

  window.fetch = async function tracedFetch(input, init) {
    const url = summarizeUrl(input)
    if (!shouldTraceUrl(url)) return nativeFetch(input, init)

    const method = String(init?.method || (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase()
    const id = nextId('NET')
    const started = performance.now()
    report({ scope: 'NET', id, phase: 'START', detail: method + ' ' + url })
    const waitTimer = setTimeout(() => {
      report({ scope: 'NET', id, phase: 'WAIT', ms: elapsed(started), detail: method + ' ' + url })
    }, 1500)

    try {
      const response = await nativeFetch(input, init)
      report({
        scope: 'NET',
        id,
        phase: response.ok ? 'DONE' : 'HTTP',
        ms: elapsed(started),
        detail: method + ' ' + url + ' status=' + response.status,
      })
      return response
    } catch (error) {
      report({ scope: 'NET', id, phase: 'FAIL', ms: elapsed(started), detail: method + ' ' + url + ' · ' + safeText(error) })
      throw error
    } finally {
      clearTimeout(waitTimer)
    }
  }

  const instrumentIndexedDb = () => {
    if (typeof IDBObjectStore === 'undefined') return
    const proto = IDBObjectStore.prototype
    for (const method of ['get', 'getAll', 'getKey', 'getAllKeys', 'count', 'openCursor']) {
      const original = proto[method]
      if (typeof original !== 'function') continue
      Object.defineProperty(proto, method, {
        configurable: true,
        writable: true,
        value: function tracedIdbOperation(...args) {
          const id = nextId('IDB')
          const store = this?.name || '?'
          const started = performance.now()
          const key = args.length > 0 ? safeText(args[0]).slice(0, 80) : ''
          const label = method + ' store=' + store + (key ? ' key=' + key : '')
          report({ scope: 'IDB', id, phase: 'START', detail: label })

          let request
          try {
            request = original.apply(this, args)
          } catch (error) {
            report({ scope: 'IDB', id, phase: 'FAIL', ms: elapsed(started), detail: label + ' · ' + safeText(error) })
            throw error
          }

          const waitTimer = setTimeout(() => {
            report({ scope: 'IDB', id, phase: 'WAIT', ms: elapsed(started), detail: label })
          }, 1000)
          let settled = false
          const finish = (phase, extra = '') => {
            if (settled) return
            settled = true
            clearTimeout(waitTimer)
            report({ scope: 'IDB', id, phase, ms: elapsed(started), detail: label + extra })
          }
          request?.addEventListener?.('success', () => finish('DONE'), { once: true })
          request?.addEventListener?.('error', () => finish('FAIL', ' · ' + safeText(request.error)), { once: true })
          return request
        },
      })
    }
  }

  instrumentIndexedDb()

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      let lastLongTaskAt = 0
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (entry.duration < 120) continue
          const now = performance.now()
          if (now - lastLongTaskAt < 250) continue
          lastLongTaskAt = now
          report({ scope: 'JS', phase: 'LONG', ms: Math.round(entry.duration), detail: 'main thread blocked' })
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      // Long Task API is optional; network/IDB tracing still works without it.
    }
  }

  window.addEventListener('error', event => {
    report({
      scope: 'ERR',
      phase: 'ERROR',
      detail: (event.message || 'window error') + (event.filename ? ' · ' + event.filename + ':' + event.lineno : ''),
    })
  })

  window.addEventListener('unhandledrejection', event => {
    report({ scope: 'ERR', phase: 'REJECT', detail: safeText(event.reason || 'Unhandled promise rejection') })
  })

  report({ scope: 'PAGE', phase: 'READY', detail: location.href })
})()
`

function localClock() {
  const date = new Date()
  return date.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(date.getMilliseconds()).padStart(3, '0')
}

function formatTraceEvent(event) {
  const scope = typeof event.scope === 'string' ? event.scope : 'DEV'
  const id = typeof event.id === 'string' && event.id ? ` ${event.id}` : ''
  const phase = typeof event.phase === 'string' ? event.phase : 'INFO'
  const duration = Number.isFinite(event.ms) ? ` ${event.ms}ms` : ''
  const detail = typeof event.detail === 'string' && event.detail ? ` · ${event.detail}` : ''
  return `${localClock()} [trace][${scope}${id}] ${phase}${duration}${detail}`
}

async function readRequestBody(req, maxBytes = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('trace payload too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function devTerminalTracePlugin() {
  return {
    name: 'l2chart-dev-terminal-trace',
    apply: 'serve',
    configureServer(server) {
      console.log('[dev-trace] Browser network/IndexedDB/long-task tracing → this terminal')
      server.middlewares.use(TRACE_ENDPOINT, async (req, res) => {
        if (req.method === 'GET') {
          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: true, version: TRACE_VERSION }))
          return
        }
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('method not allowed')
          return
        }
        try {
          const body = await readRequestBody(req)
          const event = JSON.parse(body)
          console.log(formatTraceEvent(event))
          res.statusCode = 204
          res.end()
        } catch (error) {
          console.warn(`[dev-trace] malformed event: ${error instanceof Error ? error.message : String(error)}`)
          res.statusCode = 400
          res.end('bad trace event')
        }
      })
    },
    transformIndexHtml: {
      order: 'pre',
      handler() {
        return [{
          tag: 'script',
          attrs: { type: 'module' },
          children: BROWSER_TRACE_SCRIPT,
          injectTo: 'head-prepend',
        }]
      },
    },
  }
}
