# dsh-precise-search

DSH（DeepSeek Harness）的会话正文搜索插件：跨会话搜索**提问与回答正文**，点击结果后**打开会话、把历史加载到命中那条消息、滚动到关键词并高亮**。

现有检索类插件的问题是"能搜到、点不准"：结果只带一段 snippet，不带事件序号，点击后只能在已渲染的 DOM 里做模糊文本扫描，深历史或折叠内容直接失联。本插件从根上补这一环：

```
宿主半体  sessionQuery.filterEvents()  →  { sessionId, seq, time, role, snippet }
浏览器半体  openSession(id)
           →  sessions.retain(id) / binding.session.loadThrough(seq)   // 目标事件进入渲染窗口
           →  在 [data-conversation-scroll] 的文本里匹配
           →  用上下文给候选打分，选中目标那一处
           →  Range + CSS Custom Highlight 涂色 + scrollIntoView
           →  找不到 → 展开 hidden="until-found" 折叠区重试 → 仍失败则明确提示
```

## 能力

- **跨会话**：扫描全部非 subagent 会话，按命中时间倒序返回；
- **中文友好**：按字面量匹配，不依赖分词，两字词也能命中；
- **多词查询**：空格分隔，词之间允许任意空白，词内按字面量；
- **精确定位**：命中带事件 `seq`，先把该事件所在历史页载入，再按片段上下文定位到具体那一处；
- **失败可见**：定位不到会说明原因（折叠区/历史未加载/没有会话视图），不静默、不乱跳；
- **不改宿主**：只读事件文档，不写会话、不改会话 DOM、不接管会话视图。

## 安装

```bash
dsh plugin --profile <profile> add link:D:/develop/dsh/dsh-precise-search
```

或在 DSH 的「插件 → 添加插件」中填本目录的绝对路径。安装后需要重启 DSH（宿主半体在进程启动时加载）。

## 使用

- `Ctrl+Shift+K` 打开面板，或点右下角悬浮按钮 `⌕`；
- 输入至少 2 个字符，自动搜索（中文输入法组词期间不触发）；
- `↑` / `↓` 选择，`Enter` 打开，`Esc` 关闭；
- 点击结果或回车后：打开会话 → 载入历史 → 滚动并高亮关键词。

## 已知限制

- **只搜正文**：`user/message` 与 `assistant/message` 的文本；工具调用、工具输出、推理过程、附件不进索引（这是刻意的，避免结果被工具日志淹没）；
- **依赖会话控制器的 Jump loader**（`ISession.loadThrough`）：DSH 升级若移除它，会退化为"只在已渲染窗口里找"，深历史可能定位不到（会明确提示）；
- **依赖宿主 DOM 锚点** `[data-conversation-scroll]` 与 `hidden="until-found"`：不保证跨版本稳定，但 0.2.2-alpha.3 实测存在；
- **首次搜索较慢**：逐会话读取事件文档，命中后缓存 60 秒；上限 240 个会话 / 3.5 秒软截止，超出会标"结果可能不完整"；
- **高亮依赖 CSS Custom Highlight API**（Electron 44 支持）；不支持时退回覆盖层方块。

## 开发

```bash
npm run check   # node --check
npm test        # node --test（纯逻辑，不依赖宿主）
```

目录：

- `lib/search.js`：匹配/片段纯逻辑，可单测；
- `lib/index.js`：宿主半体，注册 `/api/precise-search/query`；
- `client.js`：浏览器半体，面板 UI 与跳转定位。

接口：`GET /api/precise-search/query?q=<关键词>&limit=50`，仅接受本机回环请求。

## 卸载

```bash
dsh plugin --profile <profile> remove dsh-precise-search
```

## 回滚

代码侧用 git 回到上一次提交；插件侧卸载或 `plugin_manager` 禁用即可，宿主与其它插件不受影响。

## License

MIT
