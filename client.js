/**
 * dsh-precise-search · 浏览器半体
 *
 * 界面很轻：一个悬浮入口 + 一个命令面板式的搜索框，结果按会话正文命中列出。
 * 真正有价值的是点击之后的定位流程：
 *
 *   openSession(id)
 *     → sessions.retain(id) / binding.session.loadThrough(seq)   // 把目标事件所在历史页载入
 *     → 在 [data-conversation-scroll] 的已渲染文本里找命中
 *     → 按上下文给候选打分，选最像的那一处
 *     → Range + CSS Custom Highlight 涂色并滚到可见
 *     → 找不到就展开 hidden="until-found" 的折叠区再试一次，仍找不到则明确提示
 *
 * 刻意不做的事：不接管宿主的会话视图、不改会话 DOM、不猜"最近的一行"。
 */

// 浏览器半体通过宿主加载器注册，exports 只存在于模块工厂内。
window.__ModuleLoader__.load({
  id: 'dsh-precise-search',
  factory: () => {
const exports = {}

const STYLE_ID = 'dsh-precise-search-style'
const ENTRY_ATTR = 'data-dsh-precise-search-entry'
const MIN_QUERY = 2
const SEARCH_DEBOUNCE_MS = 220
const LOCATE_TIMEOUT_MS = 12000
const HIGHLIGHT_NAME = 'precise-search-match'

const state = {
  open: false,
  query: '',
  hits: [],
  active: -1,
  loading: false,
  error: '',
  scanned: 0,
  truncated: false,
  tookMs: 0,
  requestId: 0,
}

let activeCtx
let ui
let detach = []
let debounceTimer = 0
let requestController
let paintTimer = 0

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** 读取宿主服务：先走 ctx.get，再退回注入属性。 */
function service(name) {
  try {
    const value = activeCtx?.get?.(name)
    if (value !== undefined) return value
  } catch {
    /* 未注入时可能抛错 */
  }
  try {
    return activeCtx?.[name]
  } catch {
    return undefined
  }
}

function formatTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '时间未知'
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '时间未知'
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function toast(message, duration = 3800) {
  if (typeof document === 'undefined') return
  document.querySelectorAll('.dps-toast').forEach((node) => node.remove())
  const node = el('div', 'dps-toast', message)
  document.body.append(node)
  window.setTimeout(() => node.remove(), duration)
}

/* ------------------------------------------------------------------ *
 * 样式
 * ------------------------------------------------------------------ */

function ensureStyle() {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .dps-entry{
      position:fixed;right:18px;bottom:18px;z-index:9990;width:40px;height:40px;
      display:flex;align-items:center;justify-content:center;font-size:18px;line-height:1;
      border-radius:999px;cursor:pointer;
      border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));
      background:var(--dsw-alias-bg-modal,#fff);
      color:var(--dsw-alias-label-primary,#111);
      box-shadow:0 6px 22px rgba(0,0,0,.22);
    }
    .dps-entry:hover{filter:brightness(.97)}
    .dps-panel{
      position:fixed;left:50%;top:12vh;transform:translateX(-50%);z-index:9999;
      width:min(680px,calc(100vw - 48px));max-height:72vh;
      display:flex;flex-direction:column;overflow:hidden;
      border-radius:14px;
      border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));
      background:var(--dsw-alias-bg-modal,#fff);
      color:var(--dsw-alias-label-primary,#111);
      box-shadow:0 18px 60px rgba(0,0,0,.3);
      font:14px/1.55 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
    }
    .dps-head{display:flex;align-items:center;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18))}
    .dps-input{
      flex:1;width:100%;border:0;outline:0;background:transparent;color:inherit;
      padding:14px 16px;font-size:15px;
    }
    .dps-status{
      padding:7px 16px;font-size:12px;opacity:.68;
      border-bottom:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.12));
    }
    .dps-list{overflow:auto;overscroll-behavior:contain}
    .dps-item{padding:10px 16px;cursor:pointer;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.1))}
    .dps-item[data-active="true"]{background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.12))}
    .dps-title{display:flex;align-items:center;gap:8px;font-size:12.5px;opacity:.85}
    .dps-title-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
    .dps-badge{
      flex:none;font-size:11px;padding:1px 7px;border-radius:999px;
      background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.16));
    }
    .dps-time{flex:none;font-size:11px;opacity:.7}
    .dps-snippet{margin-top:4px;font-size:13px;white-space:pre-wrap;word-break:break-word;opacity:.92}
    .dps-snippet mark{background:rgba(255,196,0,.45);color:inherit;border-radius:3px;padding:0 1px}
    .dps-empty{padding:26px 16px;text-align:center;font-size:13px;opacity:.65}
    .dps-toast{
      position:fixed;left:50%;bottom:40px;transform:translateX(-50%);z-index:10000;
      max-width:min(560px,calc(100vw - 40px));padding:10px 16px;border-radius:10px;
      background:rgba(20,20,20,.92);color:#fff;font:13px/1.5 system-ui,sans-serif;
      box-shadow:0 10px 32px rgba(0,0,0,.32);
    }
    .dps-overlay{position:fixed;z-index:9998;pointer-events:none;border-radius:3px;background:rgba(255,196,0,.55);box-shadow:0 0 0 2px rgba(255,196,0,.35)}
    ::highlight(${HIGHLIGHT_NAME}){background-color:rgba(255,196,0,.55);color:inherit}
  `
  document.head.append(style)
}

/* ------------------------------------------------------------------ *
 * 界面
 * ------------------------------------------------------------------ */

function buildUi() {
  const entry = el('button', 'dps-entry', '⌕')
  entry.type = 'button'
  entry.title = '精准搜索（Ctrl+Shift+K）'
  entry.setAttribute(ENTRY_ATTR, '')

  const panel = el('div', 'dps-panel')
  panel.hidden = true
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', '精准搜索')

  const head = el('div', 'dps-head')
  const input = el('input', 'dps-input')
  input.type = 'search'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.placeholder = '搜索历史会话正文（至少 2 个字符）…'
  head.append(input)

  const status = el('div', 'dps-status')
  const list = el('div', 'dps-list')
  panel.append(head, status, list)

  document.body.append(entry, panel)

  let composing = false
  const onInput = () => {
    state.query = input.value
    if (!composing) scheduleSearch()
  }
  const onCompositionStart = () => { composing = true }
  const onCompositionEnd = () => { composing = false; scheduleSearch() }
  const onListClick = (event) => {
    const item = event.target instanceof Element ? event.target.closest('.dps-item') : null
    if (item === null) return
    const index = Number(item.dataset.index)
    const hit = state.hits[index]
    if (hit !== undefined) void jumpToHit(hit)
  }
  const onEntryClick = () => openPanel()

  input.addEventListener('input', onInput)
  input.addEventListener('compositionstart', onCompositionStart)
  input.addEventListener('compositionend', onCompositionEnd)
  list.addEventListener('click', onListClick)
  entry.addEventListener('click', onEntryClick)

  return {
    entry,
    panel,
    input,
    status,
    list,
    dispose() {
      input.removeEventListener('input', onInput)
      input.removeEventListener('compositionstart', onCompositionStart)
      input.removeEventListener('compositionend', onCompositionEnd)
      list.removeEventListener('click', onListClick)
      entry.removeEventListener('click', onEntryClick)
      entry.remove()
      panel.remove()
    },
  }
}

function mountUi() {
  if (document.querySelector(`[${ENTRY_ATTR}]`) !== null) return () => {}
  ui = buildUi()
  render()
  return () => {
    ui?.dispose()
    ui = undefined
  }
}

function render() {
  if (ui === undefined) return
  ui.panel.hidden = !state.open
  ui.entry.hidden = state.open
  renderStatus()
  renderList()
}

function renderStatus() {
  if (ui === undefined) return
  if (state.error !== '') {
    ui.status.textContent = state.error
    return
  }
  if (state.loading) {
    ui.status.textContent = '搜索中…'
    return
  }
  if (state.query.trim().length < MIN_QUERY) {
    ui.status.textContent = '输入至少 2 个字符，跨会话搜索提问与回答正文'
    return
  }
  if (state.hits.length === 0) {
    ui.status.textContent = '没有找到匹配的正文'
    return
  }
  const parts = [`命中 ${state.hits.length} 条`, `扫描 ${state.scanned} 个会话`, `${state.tookMs} ms`]
  if (state.truncated) parts.push('扫描有截断，结果可能不完整')
  ui.status.textContent = parts.join(' · ')
}

function renderList() {
  if (ui === undefined) return
  const list = ui.list
  list.replaceChildren()

  if (state.loading) {
    list.append(el('div', 'dps-empty', '搜索中…'))
    return
  }
  if (state.error !== '') {
    list.append(el('div', 'dps-empty', state.error))
    return
  }
  if (state.query.trim().length < MIN_QUERY) {
    list.append(el('div', 'dps-empty', '输入关键词后自动搜索'))
    return
  }
  if (state.hits.length === 0) {
    list.append(el('div', 'dps-empty', '换个关键词试试（只搜提问与回答正文，不含工具输出）'))
    return
  }

  state.hits.forEach((hit, index) => {
    const item = el('div', 'dps-item')
    item.dataset.index = String(index)
    item.dataset.active = index === state.active ? 'true' : 'false'

    const titleRow = el('div', 'dps-title')
    const badge = el('span', 'dps-badge', hit.role === 'user' ? '提问' : hit.role === 'assistant' ? '回答' : '未知')
    const title = el('span', 'dps-title-text', hit.title && String(hit.title).trim() !== '' ? hit.title : '未命名会话')
    const time = el('span', 'dps-time', formatTime(hit.time))
    titleRow.append(badge, title, time)

    const snippet = el('div', 'dps-snippet')
    const data = hit.snippet ?? {}
    snippet.append(document.createTextNode(data.before ?? ''))
    snippet.append(el('mark', '', data.text ?? ''))
    snippet.append(document.createTextNode(data.after ?? ''))

    item.append(titleRow, snippet)
    list.append(item)
  })
}

function openPanel() {
  if (ui === undefined) return
  state.open = true
  render()
  ui.input.focus()
  ui.input.select()
}

function closePanel() {
  if (ui === undefined) return
  state.open = false
  state.active = -1
  render()
}

function togglePanel() {
  if (state.open) closePanel()
  else openPanel()
}

function moveActive(delta) {
  if (state.hits.length === 0) return
  const next = state.active < 0
    ? (delta > 0 ? 0 : state.hits.length - 1)
    : Math.min(state.hits.length - 1, Math.max(0, state.active + delta))
  state.active = next
  renderList()
  const item = ui?.list.querySelector(`.dps-item[data-index="${next}"]`)
  if (item instanceof HTMLElement) item.scrollIntoView({ block: 'nearest' })
}

/* ------------------------------------------------------------------ *
 * 搜索
 * ------------------------------------------------------------------ */

function scheduleSearch() {
  window.clearTimeout(debounceTimer)
  const query = state.query.trim()
  if ([...query].length < MIN_QUERY) {
    requestController?.abort()
    state.hits = []
    state.active = -1
    state.loading = false
    state.error = ''
    state.requestId += 1
    render()
    return
  }
  debounceTimer = window.setTimeout(() => { void runSearch(query) }, SEARCH_DEBOUNCE_MS)
}

async function runSearch(query) {
  requestController?.abort()
  requestController = new AbortController()
  const requestId = state.requestId + 1
  state.requestId = requestId
  state.loading = true
  state.error = ''
  state.active = -1
  render()

  try {
    const response = await fetch(`/api/precise-search/query?q=${encodeURIComponent(query)}&limit=50`, {
      signal: requestController.signal,
      headers: { accept: 'application/json' },
    })
    const data = await response.json().catch(() => undefined)
    if (requestId !== state.requestId) return
    if (!response.ok || data === undefined || data.ok === false) {
      state.hits = []
      state.error = data && data.error ? String(data.error) : `搜索失败（HTTP ${response.status}）`
      return
    }
    state.hits = Array.isArray(data.hits) ? data.hits : []
    state.scanned = typeof data.scanned === 'number' ? data.scanned : 0
    state.truncated = data.truncated === true
    state.tookMs = typeof data.tookMs === 'number' ? data.tookMs : 0
  } catch (error) {
    if (error?.name === 'AbortError') return
    if (requestId !== state.requestId) return
    state.hits = []
    state.error = `搜索请求失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    if (requestId === state.requestId) {
      state.loading = false
      render()
    }
  }
}

/* ------------------------------------------------------------------ *
 * 跳转定位
 * ------------------------------------------------------------------ */

/** 打开会话（视图导航）：0.1.6 起归 uiWorkspace.openSession，老宿主退回 sessions.open。 */
function openSession(sessionId) {
  const workspace = service('uiWorkspace')
  if (workspace !== undefined && typeof workspace.openSession === 'function') {
    workspace.openSession(sessionId)
    return true
  }
  const sessions = service('sessions')
  if (sessions !== undefined && typeof sessions.open === 'function') {
    sessions.open(sessionId)
    return true
  }
  return false
}

/**
 * 把目标事件所在历史页载入窗口。
 * 用的是会话控制器上的 Jump loader（ISession.loadThrough），失败时返回 false，
 * 后续仍会尝试在已渲染内容里找——只是深历史会找不到。
 */
async function loadThrough(sessionId, seq) {
  const sessions = service('sessions')
  if (sessions === undefined || typeof sessions.retain !== 'function') return false
  let reference
  try {
    reference = sessions.retain(sessionId, { source: 'precise-search' })
  } catch {
    return false
  }
  try {
    if (reference?.ready !== undefined && typeof reference.ready.then === 'function') {
      await reference.ready
    }
    const session = reference?.binding?.session
    if (session === undefined || typeof session.loadThrough !== 'function') return false
    await session.loadThrough(seq)
    return true
  } catch {
    return false
  } finally {
    try {
      reference?.release?.()
    } catch {
      /* 释放失败不阻塞 */
    }
  }
}

function conversationScroller() {
  return document.querySelector('[data-conversation-scroll]')
}

/** 收集容器内的文本节点并拼成一整串，用于跨节点匹配与偏移映射。 */
function textNodesOf(root) {
  const nodes = []
  let full = ''
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (parent === null) return NodeFilter.FILTER_REJECT
      const tag = parent.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT
      if ((node.nodeValue ?? '') === '') return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  while (walker.nextNode()) {
    const node = walker.currentNode
    nodes.push({ node, start: full.length })
    full += node.nodeValue ?? ''
  }
  return { nodes, full }
}

/** 把字符串偏移映射回 (文本节点, 节点内偏移)。 */
function pointAt(nodes, offset) {
  let low = 0
  let high = nodes.length - 1
  let best = nodes[0]
  while (low <= high) {
    const mid = (low + high) >> 1
    if (nodes[mid].start <= offset) {
      best = nodes[mid]
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  const value = best.node.nodeValue ?? ''
  return { node: best.node, offset: Math.min(Math.max(0, offset - best.start), value.length) }
}

function occurrencesOf(full, needle) {
  const haystack = full.toLowerCase()
  const target = needle.toLowerCase()
  if (target === '') return []
  const result = []
  let from = 0
  while (result.length < 50) {
    const index = haystack.indexOf(target, from)
    if (index < 0) break
    result.push({ index, length: needle.length })
    from = index + Math.max(1, target.length)
  }
  return result
}

/** 查询本身（可能多个词、词间空白不同）的兜底匹配。 */
function flexibleOccurrences(full, query) {
  const terms = String(query ?? '').trim().split(/\s+/u).filter((term) => term !== '')
  if (terms.length === 0) return []
  const pattern = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s+')
  let re
  try {
    re = new RegExp(pattern, 'giu')
  } catch {
    return []
  }
  const result = []
  let match
  while ((match = re.exec(full)) !== null && result.length < 50) {
    result.push({ index: match.index, length: match[0].length })
    if (match[0].length === 0) re.lastIndex += 1
  }
  return result
}

function commonPrefix(a, b) {
  const limit = Math.min(a.length, b.length)
  let i = 0
  while (i < limit && a[i] === b[i]) i += 1
  return i
}

function commonSuffix(a, b) {
  const limit = Math.min(a.length, b.length)
  let i = 0
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1
  return i
}

/** 用命中片段的前后文给候选打分：上下文越吻合，越可能是目标那一处。 */
function contextScore(full, index, length, snippet) {
  const before = String(snippet?.before ?? '').replace(/^…/u, '')
  const after = String(snippet?.after ?? '').replace(/…$/u, '')
  const left = full.slice(Math.max(0, index - before.length), index)
  const right = full.slice(index + length, index + length + after.length)
  return commonSuffix(left, before) + commonPrefix(right, after)
}

function locateInScroller(scroller, hit, fallbackQuery) {
  const { nodes, full } = textNodesOf(scroller)
  if (nodes.length === 0) return undefined

  const needle = String(hit?.snippet?.text ?? '').trim()
  let candidates = needle !== '' ? occurrencesOf(full, needle) : []
  if (candidates.length === 0) candidates = occurrencesOf(full, fallbackQuery)
  if (candidates.length === 0) candidates = flexibleOccurrences(full, fallbackQuery)
  if (candidates.length === 0) return undefined

  let best = candidates[0]
  let bestScore = -1
  for (const candidate of candidates) {
    const score = contextScore(full, candidate.index, candidate.length, hit?.snippet)
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }

  const start = pointAt(nodes, best.index)
  const end = pointAt(nodes, best.index + best.length)
  const range = document.createRange()
  try {
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
  } catch {
    return undefined
  }
  return { range, score: bestScore }
}

function paintMatch(range) {
  const container = range.startContainer
  const element = container instanceof Element ? container : container.parentElement
  if (element !== null) {
    try {
      element.scrollIntoView({ block: 'center', behavior: 'instant' })
    } catch {
      try { element.scrollIntoView() } catch { /* 滚动失败不阻塞 */ }
    }
  }
  if (typeof Highlight === 'function' && typeof CSS !== 'undefined' && CSS.highlights) {
    try {
      CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range))
      window.clearTimeout(paintTimer)
      paintTimer = window.setTimeout(() => {
        try { CSS.highlights.delete(HIGHLIGHT_NAME) } catch { /* 已释放 */ }
      }, 20000)
      return
    } catch {
      /* 退回覆盖层 */
    }
  }
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return
  const layer = el('div', 'dps-overlay')
  Object.assign(layer.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  })
  document.body.append(layer)
  window.setTimeout(() => layer.remove(), 9000)
}

/** 折叠区里的内容用 `hidden="until-found"`，宿主监听 beforematch 事件来展开。 */
function expandHidden(scroller) {
  const hidden = scroller.querySelectorAll('[hidden="until-found"]')
  let count = 0
  for (const node of hidden) {
    if (count >= 30) break
    try {
      node.dispatchEvent(new Event('beforematch', { bubbles: true }))
      count += 1
    } catch {
      /* 展开失败不阻塞 */
    }
  }
}

async function locateInConversation(hit, query) {
  const started = Date.now()
  let expanded = false
  let sawScroller = false
  let lastSignature = -1
  let lastScan = 0

  while (Date.now() - started < LOCATE_TIMEOUT_MS) {
    const scroller = conversationScroller()
    if (scroller !== null) {
      sawScroller = true
      const signature = (scroller.textContent ?? '').length
      const stale = Date.now() - lastScan > 500
      if (signature !== lastSignature || stale) {
        lastSignature = signature
        lastScan = Date.now()
        const found = locateInScroller(scroller, hit, query)
        if (found !== undefined) {
          paintMatch(found.range)
          return { ok: true }
        }
      }
      if (!expanded && Date.now() - started > 900) {
        expanded = true
        expandHidden(scroller)
        lastSignature = -1
      }
    }
    await sleep(150)
  }

  return {
    ok: false,
    reason: sawScroller
      ? '已打开会话，但没在已渲染内容里找到这个关键词（可能在折叠区或尚未加载的历史里）'
      : '已打开会话，但没找到会话视图',
  }
}

async function jumpToHit(hit) {
  const query = state.query
  closePanel()

  if (!openSession(hit.sessionId)) {
    toast('当前环境无法直接打开会话')
    return
  }

  const loaded = await loadThrough(hit.sessionId, hit.seq)
  if (!loaded) {
    // 载入失败仍继续尝试：目标也许本来就在当前窗口里。
    console.info('[precise-search] loadThrough unavailable; locating within rendered window only')
  }

  const result = await locateInConversation(hit, query)
  if (result.ok) {
    toast('已定位到命中位置')
  } else {
    toast(result.reason)
  }
}

/* ------------------------------------------------------------------ *
 * 键盘与全局事件
 * ------------------------------------------------------------------ */

function onKeydown(event) {
  const isToggle = event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
    && (event.key === 'K' || event.key === 'k')
  if (isToggle) {
    event.preventDefault()
    event.stopPropagation()
    togglePanel()
    return
  }
  if (!state.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closePanel()
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    moveActive(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (event.key === 'Enter') {
    const hit = state.hits[state.active]
    if (hit !== undefined) {
      event.preventDefault()
      void jumpToHit(hit)
    }
  }
}

function onPointerDown(event) {
  if (!state.open) return
  const target = event.target
  if (!(target instanceof Element)) return
  if (ui !== undefined && (ui.panel.contains(target) || ui.entry.contains(target))) return
  closePanel()
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

exports.inject = ['sessions']

exports.apply = (ctx) => {
  activeCtx = ctx
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    ensureStyle()
    const disposeUi = mountUi()
    const keydown = (event) => onKeydown(event)
    const pointer = (event) => onPointerDown(event)
    document.addEventListener('keydown', keydown, true)
    document.addEventListener('pointerdown', pointer, true)
    detach = [
      () => document.removeEventListener('keydown', keydown, true),
      () => document.removeEventListener('pointerdown', pointer, true),
    ]
    return () => {
      for (const dispose of detach) {
        try { dispose() } catch { /* 忽略 */ }
      }
      detach = []
      disposeUi()
    }
  })
}

return exports
  },
})
