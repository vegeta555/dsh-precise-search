/**
 * 纯匹配逻辑：不依赖宿主、不碰 DOM，可以在 node --test 里直接单测。
 *
 * 匹配语义刻意保持简单：
 * - 关键词按空白切成多个词，词之间允许任意空白（`\s+`），词内按字面量匹配；
 * - 大小写不敏感（中文没有大小写，不受影响）；
 * - 不做分词、不做正则、不做语义扩展——用户看到什么就能搜到什么。
 */

/** 只把这两类事件当作"正文"；工具调用/输出/思考过程不参与。 */
export const TEXT_EVENT_TYPES = Object.freeze(['user/message', 'assistant/message'])

/** 查询按空白切成词；空查询返回空数组。 */
export function splitTerms(query) {
  return String(query ?? '')
    .trim()
    .split(/\s+/u)
    .filter((term) => term !== '')
}

/** 转义正则元字符，保证用户输入始终按字面量处理。 */
export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * 把查询编译成匹配器。
 * @param {string} query 用户输入
 * @returns {{ test(text: string): boolean, find(text: string): { index: number, length: number, text: string } | undefined } | undefined}
 */
export function compileQuery(query) {
  const terms = splitTerms(query)
  if (terms.length === 0) return undefined
  const pattern = terms.map(escapeRegExp).join('\\s+')
  let re
  try {
    re = new RegExp(pattern, 'iu')
  } catch {
    return undefined
  }
  return {
    test(text) {
      if (typeof text !== 'string' || text === '') return false
      re.lastIndex = 0
      return re.test(text)
    },
    find(text) {
      if (typeof text !== 'string' || text === '') return undefined
      re.lastIndex = 0
      const match = re.exec(text)
      if (match === null) return undefined
      return { index: match.index, length: match[0].length, text: match[0] }
    },
  }
}

/** 事件类型是否属于正文。 */
export function isTextEvent(type) {
  return TEXT_EVENT_TYPES.includes(type)
}

/** 事件类型 → 结果里展示的角色。 */
export function roleOf(type) {
  if (type === 'user/message') return 'user'
  if (type === 'assistant/message') return 'assistant'
  return 'unknown'
}

/**
 * 生成命中片段：命中词两侧各保留 radius 个字符，被截断的一侧加省略号。
 * 片段同时带着原始上下文，浏览器半体用它给 DOM 命中位置打分（避免落到同词的错误消息上）。
 */
export function makeSnippet(text, index, length, radius = 60) {
  const source = typeof text === 'string' ? text : ''
  const start = Math.max(0, index - radius)
  const end = Math.min(source.length, index + length + radius)
  return {
    before: (start > 0 ? '…' : '') + source.slice(start, index),
    text: source.slice(index, index + length),
    after: source.slice(index + length, end) + (end < source.length ? '…' : ''),
  }
}
