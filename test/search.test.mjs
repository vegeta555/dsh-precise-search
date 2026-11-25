import assert from 'node:assert/strict'
import test from 'node:test'

import { compileQuery, isTextEvent, makeSnippet, roleOf, splitTerms } from '../lib/search.js'

test('splitTerms: 空白切词并丢弃空串', () => {
  assert.deepEqual(splitTerms('  会话   搜索 '), ['会话', '搜索'])
  assert.deepEqual(splitTerms(''), [])
  assert.deepEqual(splitTerms('   '), [])
})

test('compileQuery: 中文子串命中，大小写不敏感', () => {
  const matcher = compileQuery('会话')
  assert.ok(matcher)
  assert.equal(matcher.test('我在排查会话搜索插件的定位问题'), true)
  assert.equal(matcher.test('没有这个词'), false)

  const latin = compileQuery('Precise')
  assert.equal(latin.test('a precise search'), true)
})

test('compileQuery: 词间空白灵活，词内按字面量', () => {
  const matcher = compileQuery('会话 搜索')
  assert.equal(matcher.test('会话 搜索'), true)
  assert.equal(matcher.test('会话\n搜索'), true)
  assert.equal(matcher.test('会话与搜索'), false)
  // 词与词之间要求至少一个空白；中文连写不当作两个词。
  assert.equal(matcher.test('会话搜索'), false)

  const literal = compileQuery('a+b')
  assert.equal(literal.test('公式 a+b 的用法'), true)
  assert.equal(literal.test('aaab'), false)
})

test('compileQuery: find 返回命中位置与长度', () => {
  const matcher = compileQuery('定位')
  const found = matcher.find('点击之后不能定位到关键词')
  assert.ok(found)
  assert.equal(found.text, '定位')
  assert.equal('点击之后不能定位到关键词'.slice(found.index, found.index + found.length), '定位')
})

test('compileQuery: 空查询返回 undefined', () => {
  assert.equal(compileQuery(''), undefined)
  assert.equal(compileQuery('   '), undefined)
})

test('makeSnippet: 截断加省略号且保留命中词', () => {
  const text = 'a'.repeat(100) + '关键词' + 'b'.repeat(100)
  const index = text.indexOf('关键词')
  const snippet = makeSnippet(text, index, 3, 10)
  assert.ok(snippet.before.startsWith('…'))
  assert.equal(snippet.text, '关键词')
  assert.ok(snippet.after.endsWith('…'))
  assert.ok(snippet.before.includes('a'))
  assert.ok(snippet.after.includes('b'))
})

test('makeSnippet: 贴近开头/结尾时不多加省略号', () => {
  const text = '关键词就在开头'
  const snippet = makeSnippet(text, 0, 3, 10)
  assert.equal(snippet.before, '')
  assert.equal(snippet.text, '关键词')
  assert.equal(snippet.after, '就在开头')
})

test('事件类型只认正文', () => {
  assert.equal(isTextEvent('user/message'), true)
  assert.equal(isTextEvent('assistant/message'), true)
  assert.equal(isTextEvent('tool/result'), false)
  assert.equal(isTextEvent('tool/call'), false)
  assert.equal(roleOf('user/message'), 'user')
  assert.equal(roleOf('assistant/message'), 'assistant')
})
