/**
 * dsh-precise-search · 宿主半体
 *
 * 只做一件事：把"命中在哪个会话的哪条事件"查出来，连同片段与上下文一起交给浏览器半体。
 * 浏览器半体再负责打开会话、把历史加载到那条事件、滚动并高亮。
 *
 * 为什么不用宿主的 searchSessions（全文索引）：
 * - 默认 profile 的全文索引是关闭的（openAt: never），走它只能退回逐会话扫描；
 * - 即使打开，FTS5 对中文按整段分词，`光速` 这种两字查询会搜不到；
 * - 它返回的命中不带事件序号，而"精确跳到关键词"缺了序号就只能靠猜。
 * 所以这里直接读语义事件文档（filterEvents），按字面量匹配，命中带 seq。
 */

import { compileQuery, isTextEvent, makeSnippet, roleOf } from './search.js'

const ROUTE_PATH = '/api/precise-search/query'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const MAX_SCAN_SESSIONS = 240
const SCAN_DEADLINE_MS = 3500
const MAX_HITS_PER_SESSION = 3
const DOCS_TTL_MS = 60_000
const DOCS_CACHE_MAX = 120
const TITLE_TTL_MS = 5 * 60_000
const TITLE_CACHE_MAX = 400

/** 会话 id → { at, docs }。文档是只读快照，过期后重读。 */
const docsCache = new Map()
/** 会话 id → { at, title }。标题很少变，缓存久一点。 */
const titleCache = new Map()

function cacheGet(cache, key, ttl) {
  const entry = cache.get(key)
  if (entry === undefined) return undefined
  if (Date.now() - entry.at > ttl) {
    cache.delete(key)
    return undefined
  }
  return entry
}

function cachePut(cache, key, value, max) {
  cache.set(key, { at: Date.now(), ...value })
  if (cache.size <= max) return
  // Map 保持插入顺序：删掉最老的 10%。
  const drop = Math.max(1, Math.ceil(max * 0.1))
  let removed = 0
  for (const oldest of cache.keys()) {
    cache.delete(oldest)
    removed += 1
    if (removed >= drop) break
  }
}

/** 读取宿主服务：cordis 4 的 ctx.get 在未注册时返回 undefined，属性访问可能抛错。 */
function service(ctx, name) {
  try {
    const value = ctx.get?.(name)
    if (value !== undefined) return value
  } catch {
    /* 服务未 inject 时可能是抛错 */
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

/** 只接受本机回环：桌面端的 GUI 走 127.0.0.1，远程反代一律拒绝。 */
function isLoopback(request) {
  const address = request?.socket?.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(payload)
}

function isSubagentHeader(header) {
  if (typeof header !== 'object' || header === null) return false
  if (header.origin === 'subagent') return true
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0
}

/** 一次扫描最多保留多少条命中（避免一个高频词把内存打满）。 */
function trimHits(hits, limit) {
  return hits.length > limit ? hits.slice(0, limit) : hits
}

async function loadDocs(sessionQuery, sessionId) {
  const cached = cacheGet(docsCache, sessionId, DOCS_TTL_MS)
  if (cached !== undefined) return cached.docs
  const raw = await sessionQuery.filterEvents(sessionId, [])
  const docs = raw.map((doc) => ({
    seq: doc.seq,
    type: doc.type,
    time: doc.time,
    surface: doc.surface,
    text: typeof doc.text === 'string' ? doc.text : '',
  }))
  cachePut(docsCache, sessionId, { docs }, DOCS_CACHE_MAX)
  return docs
}

async function loadTitle(sessionQuery, sessionId) {
  const cached = cacheGet(titleCache, sessionId, TITLE_TTL_MS)
  if (cached !== undefined) return cached.title
  let title = ''
  try {
    if (typeof sessionQuery.readTitle === 'function') {
      const value = await sessionQuery.readTitle(sessionId)
      if (typeof value === 'string') title = value
    }
  } catch {
    title = ''
  }
  cachePut(titleCache, sessionId, { title }, TITLE_CACHE_MAX)
  return title
}

/**
 * 跨会话扫描。
 * @returns {Promise<{ hits: object[], scanned: number, truncated: boolean, tookMs: number }>}
 */
async function searchSessions(ctx, query, limit, signal) {
  const matcher = compileQuery(query)
  if (matcher === undefined) return { hits: [], scanned: 0, truncated: false, tookMs: 0 }

  const sessionQuery = service(ctx, 'sessionQuery')
  if (sessionQuery === undefined
    || typeof sessionQuery.listSessions !== 'function'
    || typeof sessionQuery.filterEvents !== 'function') {
    throw new Error('宿主没有提供 sessionQuery 服务，无法搜索会话正文')
  }

  const started = Date.now()
  const records = await sessionQuery.listSessions(signal)
  const sessions = Array.isArray(records) ? records : []

  const hits = []
  let scanned = 0
  let truncated = false

  for (const record of sessions) {
    if (scanned >= MAX_SCAN_SESSIONS) {
      truncated = true
      break
    }
    if (Date.now() - started > SCAN_DEADLINE_MS) {
      truncated = true
      break
    }
    const header = record?.header ?? record
    const sessionId = header?.id
    if (typeof sessionId !== 'string' || sessionId === '') continue
    if (isSubagentHeader(header)) continue
    scanned += 1

    let docs
    try {
      docs = await loadDocs(sessionQuery, sessionId)
    } catch {
      continue // 单个会话读不出来不拖垮整次搜索
    }

    const matched = []
    for (const doc of docs) {
      if (!isTextEvent(doc.type)) continue
      if (doc.surface !== undefined && doc.surface !== 'current') continue
      const found = matcher.find(doc.text)
      if (found === undefined) continue
      matched.push({ doc, found })
      if (matched.length >= MAX_HITS_PER_SESSION) break
    }
    if (matched.length === 0) continue

    const title = await loadTitle(sessionQuery, sessionId)
    for (const { doc, found } of matched) {
      hits.push({
        sessionId,
        title,
        seq: doc.seq,
        time: typeof doc.time === 'number' ? doc.time : 0,
        role: roleOf(doc.type),
        snippet: makeSnippet(doc.text, found.index, found.length),
      })
    }

    if (hits.length >= limit * 4) break
  }

  hits.sort((a, b) => b.time - a.time)
  return { hits: trimHits(hits, limit), scanned, truncated, tookMs: Date.now() - started }
}

async function handleQuery(ctx, request, response) {
  if (!isLoopback(request)) {
    sendJson(response, 403, { ok: false, error: 'forbidden: loopback-only' })
    return
  }
  if (request.method !== 'GET') {
    sendJson(response, 405, { ok: false, error: `method not allowed: ${String(request.method)}` })
    return
  }

  let url
  try {
    url = new URL('http://localhost' + (request.url ?? '/'))
  } catch {
    sendJson(response, 400, { ok: false, error: 'invalid query string' })
    return
  }

  const query = (url.searchParams.get('q') ?? '').trim()
  const rawLimit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit = Number.isFinite(rawLimit) ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(rawLimit))) : DEFAULT_LIMIT

  // 单字查询（含 CJK 单字）命中面太大，且要付全量扫描成本，直接返回空。
  if ([...query].length < 2) {
    sendJson(response, 200, { ok: true, query, hits: [], scanned: 0, truncated: false, tookMs: 0 })
    return
  }

  const controller = new AbortController()
  const onClose = () => controller.abort()
  request.once('close', onClose)
  try {
    const result = await searchSessions(ctx, query, limit, controller.signal)
    sendJson(response, 200, { ok: true, query, ...result })
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    request.removeListener('close', onClose)
  }
}

/**
 * cordis 插件入口：导出 name / inject / apply。
 * webServer 只在 Host 启动后可用，所以放进 ctx.inject 回调里注册。
 */
export const name = 'precise-search'

export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const server = webCtx.webServer
      const disposers = [
        server.register({
          kind: 'exact',
          path: ROUTE_PATH,
          handler: (request, response) => handleQuery(ctx, request, response),
        }),
      ]
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 释放失败不阻塞卸载 */
          }
        }
      }
    })
  })
}
