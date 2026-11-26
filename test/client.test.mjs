import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('浏览器入口无需 CommonJS 全局变量即可向宿主注册可用插件', () => {
  const registrations = []
  // 浏览器只提供宿主加载器，不提供 Node.js 的 exports/module。
  const context = vm.createContext({
    window: {
      __ModuleLoader__: {
        load(entry) { registrations.push(entry) },
      },
    },
  })

  vm.runInContext(clientSource, context, { filename: 'client.js' })

  assert.equal(registrations.length, 1)
  const entry = registrations[0]
  assert.equal(entry.id, manifest.name)
  assert.equal(typeof entry.factory, 'function')

  // 构造模块时不应挂载界面；宿主拿到 apply 后才负责激活。
  const plugin = entry.factory()
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(Array.from(plugin.inject), manifest.dsh.client.inject)
})
