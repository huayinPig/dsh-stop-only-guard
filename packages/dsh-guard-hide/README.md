# dsh-guard-hide

把 `dsh-stop-only-guard` 注入的 `[stop-only-guard] …` 补救消息**从聊天界面上隐藏**，
但消息本身照旧进会话、模型照旧收到。

## 为什么能藏

`dsh-stop-only-guard` 在轮次关闭前用 `agent.steer()` 塞一条 `role: 'user'`、
`source: { kind: 'user' }` 的消息。它在会话里是一条正常的 `user/message` 事件，
所以模型能收到 —— 这是功能的关键，不能动。

能藏的凭据是 **消息 id**：

1. guard 生成注入消息时把 id 写成 `stop-only-guard:<uuid>`（`buildSteerMessage`）。
2. Chat 渲染每个节点时，外层 `div` 上带
   `data-chat-node-key="<kind 长度>:<kind><messageId>"`（见 `dsh-client-ui-chat`
   的 `ChatNodeSeat.tsx`，`conversationContextKey()` 把 kind 和 id 拼起来）。
   于是注入消息那行的属性里一定含 `stop-only-guard`。
3. 本插件的 Client 半身塞一条 CSS：

   ```css
   [data-chat-node-key*="stop-only-guard"]{display:none!important}
   ```

   纯 CSS，React 第一次渲染时生效，没有闪烁，也不需要轮询。

两条兜底：

- **老会话**：本插件装上之前已经落盘的注入消息 id 是随机 UUID，没有标记。
- **待发送气泡**：steering 消息在被领取之前会以 `[data-pending-steering]` 的气泡出现，
  那个气泡没有任何 id 属性。

这两类由一次轻量 DOM 扫描补藏：只检查 `user` / `steering` 行与待发送 steering 气泡，
条件是「正文去掉前导空白后以 `[stop-only-guard]` 开头」，中招的行打上
`data-dsh-guard-hide` + `hidden`，CSS 同样把它藏掉。助手正文里引用这个标记不受影响。

给行加 `hidden` 而不是只挂 class，是因为 DSH 自己的 Chat 布局/滚动逻辑就用
`[hidden]` 排除隐藏行（`use-chat-viewport` 里的 `:not([hidden])` 选择器和
`ChatView.module.css` 的行间距规则），这样隐藏行不会留下多余空隙。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半身，空插件；只负责让 DSH 认领这个包 |
| `client.js` | Client 半身，样式 + 观察者，全部逻辑在这里 |
| `cordis.patch.yml` | bundle 层：`insert` 一行 `id: guard-hide` |
| `package.json` | `dsh.bundle.patch` + `dsh.client.platform: web` |

## 装法

```powershell
# 1. 本目录放在 <profile>\vendor\ 下
# 2. 在 <profile>\node_modules 建 junction，和 dsh-stop-only-guard 一样
New-Item -ItemType Junction `
  -Path  "<profile>\node_modules\dsh-guard-hide" `
  -Target "<profile>\vendor\dsh-guard-hide"
# 3. <profile>\package.json：dependencies 加 "dsh-guard-hide": "file:./vendor/dsh-guard-hide"，
#    dsh.profile.bundles 加 "dsh-guard-hide"
```

profile 的 `package.json` 和 `cordis.patch.yml` 被 dsh-hmr 盯着，改完会热重组
（`recomposeProfile`），新增的 bundle 行直接起，Client 模块进入页面模块图，
`client-hmr` 把新的 client 半身热加载进来 —— 不需要重启 DSH。

## 怎么验证

1. 界面上没有 `[stop-only-guard]` 气泡：原窗口里用无障碍树找这个字符串应当找不到。
2. 模型还收到：注入后紧跟的助手回复正常出现；会话日志里 `user/message` 事件仍在，
   `id` 变成 `stop-only-guard:<uuid>`。

## 怎么撤

1. profile `package.json`：删掉 `dependencies` 里的 `"dsh-guard-hide"` 和
   `dsh.profile.bundles` 里的 `"dsh-guard-hide"`。
2. 删掉 `node_modules\dsh-guard-hide` junction（`Remove-Item`，不要删 vendor 目录）。
3. 想连 guard 的 id 标记一起撤：把 `dsh-stop-only-guard` 的 `index.js` 换成没有 id 标记的版本
   （git 回滚到本插件加入之前的提交）。
   只撤两端中的一端也不会坏：没有 id 标记时，本插件的正文扫描依然能藏住新消息
   （只是晚一帧、多一次 DOM 扫描）。
