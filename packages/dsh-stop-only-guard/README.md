# dsh-stop-only-guard

DSH 本地插件：把「只在思考里走完、正文为空、正常结束」的轮次救回来。

## 它解决什么问题

`deepseek-flash` 偶尔一整轮只在 reasoning（思考）通道里输出，最后一个 chunk 是：

```json
{ "type": "finish", "reason": { "kind": "stop" } }
```

`assistant/message` 的 `message.content` 里只有 reasoning 块 —— 没有 text，也没有 tool-call。
`dsh-agent-loop` 的 `step()` 只看消息里有没有 tool-call，没有就 `return { kind: 'completed' }`，
这一轮被当成正常收尾；`agent/turn-stopping` 之后 `inbox.nextStep` 仍为空，循环 `break`，
用户界面上只看到一条空白回复。

本插件在轮次关闭前插手：往 `inbox.next-step` 塞一句话，让同一个 turn 再开一步，
模型就被迫把要说的话写成正文。

## 扩展点（全部公开，不改 app.asar）

| 扩展点 | 用途 |
| --- | --- |
| `agent/assistant-stream` | 观察每个 attempt 的 `start` / `chunk` / `end` 帧，统计有没有 text、tool-call，记下 `finish.reason.kind` |
| `agent/turn-stopping` | 轮次即将关闭时介入（`serial` 派发，await 完监听器才继续判空） |
| `agent.steer(message)` | `send(message, 'next-step', true)`，使 `turn()` 里 `inbox.nextStep.length === 0` 的判空失效 |

## 判定条件（四条全中才救）

1. 该 attempt 的 `finish.reason.kind === 'stop'`
2. 内容块里没有 text、也没有 tool-call（只有 reasoning，或除 usage/finish 外完全为空）
3. 当前 `turn-stopping` 的 `turn` 就是该 attempt 的 `turn`
4. `signal.aborted` 为假

另外，该 attempt 的 `end.outcome.kind` 必须是 `committed`（报错 / 取消 / abandoned 一律放行）。

补救方式：注入一条短消息，形状是合法的 UserMessage：

```js
{ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
```

注入文案里会带上**被吞那轮的思考节选**（默认最多 600 字），这样模型是「接着自己原来的思路」把正文补出来，
而不是凭空重新说一段：

```
[stop-only-guard] 上一轮你只在思考里走完了、正文是空的。你当时的思考（节选）：
<<<
（这里放 reasoning 原文，最多 600 个字符，超出就截断并加「…」）
>>>
请接着这段把正文补出来，不要只思考。
```

reasoning 原文的来源分两级（`agent/assistant-stream` 里累积）：

1. 该 attempt 的 `reasoning-delta` chunk 的 `text` 依次拼接；
2. 没有 delta 时，退回 `block-end` 里 `block.type === 'reasoning'` 的 `block.text`。

只保留「最后一个被判定为 stop-only 的 attempt」的 reasoning；拿不到（完全空 / 只有空白）或
`reasoningExcerptChars: 0` 时，退回下面这句不带节选的默认文案：

```
[stop-only-guard] 上一轮你只在思考里走完了、正文是空的。请立刻把要说的话写成正文回复，不要只思考。
```

## 配置

```yaml
- id: dsh-stop-only-guard
  name: dsh-stop-only-guard
  config:
    enabled: true
    maxRemediesPerTurn: 3
    maxRemediesPerAgent: 30
    reasoningExcerptChars: 600
    log: true
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 时连监听器都不注册 |
| `maxRemediesPerTurn` | `3` | 同一个 turn 内最多补救几次；`0` = 不限 |
| `maxRemediesPerAgent` | `30` | 单个 agent 生命周期内最多补救几次；`0` = 不限 |
| `reasoningExcerptChars` | `600` | 注入文案里带多少字思考节选；超出截断并加「…」；`0` = 不带节选 |
| `log` | `true` | 是否用 `ctx.logger.warn` 记录命中与放行 |
| `steerText` | 内置中文短句 | 只在拿不到 reasoning（或 `reasoningExcerptChars: 0`）时用作兜底文案 |

## 安全设计（fail-open）

1. 默认 `enabled: true`（装了即生效），但可用 config 关掉。
2. 每个监听器内部 `try/catch`，异常只记日志。`agent/turn-stopping` 是 `serial` 派发，
   监听器抛错会把整轮变成 error，所以这条是硬要求。
3. `signal.aborted` 为真时绝不复活轮次。
4. 双重上限防死循环：每 turn 3 次、每 agent 30 次。
5. 纯内存状态（`WeakMap`），不写文件、不发网络请求、零运行时依赖。

## 安装（照 dsh-empty-turn-guard 的本地包方式）

1. 源码放在 `<profile>\vendor\dsh-stop-only-guard\`（`index.js` + `package.json` + `cordis.patch.yml` + 本文件）。
2. `<profile>\node_modules\dsh-stop-only-guard` 建 junction 指向本目录（让 Loader 能按包名解析）。
3. profile 的 `package.json`：`dependencies` 加 `"dsh-stop-only-guard": "file:./vendor/dsh-stop-only-guard"`，
   `dsh.profile.bundles` 加 `"dsh-stop-only-guard"`。
4. profile 的 `cordis.patch.yml` 末尾加一条按 id 的 override（见上面「配置」）。

> 注意：Loader 的 patch 方言里，非 `insert` 的 patch 必须命中已存在的行，否则「warn + 跳过」。
> 所以本包自带 `cordis.patch.yml`（`insert` 一行），profile 里那条按 id 的条目是**覆盖它的 config**。
> 只有 profile 那一条、没有本包的 `insert`，插件不会挂载。

改完 profile 文件后 DSH 的 profile HMR 会自动重新组合（`cordis.patch.yml` 与 `package.json` 都在监视列表里），
正常情况下不需要重启 DSH。若 HMR 报 `restart required`，则需要重启后才生效。

## 怎么确认生效

1. 命中时日志里会出现：

```
[stop-only-guard] turn 12 step 3 命中（stop-only：finish=stop，内容块只有 reasoning 或为空（无 text、无 tool-call）），已注入第 1 次补救（本 turn 第 1 次，带思考节选，文案 738 字）。
```

2. 更直观的证据：会话里会**立刻多出一条用户消息**（以 `[stop-only-guard]` 开头）：
   - 拿得到 reasoning 时，消息里能看到 `<<<` … `>>>` 包住的思考原文（最多 600 字）；
   - 拿不到时就是那句短的默认文案。
   随后模型应当接着输出正文。

## 自检（离线，不启动 DSH）

```powershell
node "<profile>\vendor\dsh-stop-only-guard\selftest.mjs"
# 期望最后一行：VERDICT: OK
```

`selftest.mjs` 用假 ctx / 假 agent 回放帧序列，覆盖判定表、主路径、不该救的 6 种形态、
双重上限、aborted、turn 不一致、abandoned、异常 payload、steer 抛错、多 agent 隔离、日志开关，
以及 0.2.0 新增的思考节选行为（带节选 / 600 字截断 / 自定义上限 / 0 = 不带节选 /
无 reasoning 回退 / block-end 兜底 / 空白 reasoning / 多段 delta 拼接 / 只保留最后一个 attempt /
日志标注），共 41 项。

## 回滚

1. 从 profile 的 `cordis.patch.yml` 删掉 `- id: dsh-stop-only-guard` 那 4~6 行（`config` 段一起删）。
2. 从 profile 的 `package.json` 删掉 `dsh.profile.bundles` 里的 `"dsh-stop-only-guard"` 和
   `dependencies` 里的 `"dsh-stop-only-guard"`。
3. 删 `node_modules\dsh-stop-only-guard`（junction）和 `vendor\dsh-stop-only-guard`（源码目录）。
4. 只想临时关掉、不删文件：把 profile 那条 config 的 `enabled` 改成 `false`。

## 已知边界

- 只救 `finish.reason.kind === 'stop'` 的轮次；`max-tokens`、`tool-calls`、`error`、`aborted` 一概不动。
- 救回来的那一步会多消耗一次模型调用（最多每 turn 3 次、每 agent 30 次）。
- 如果模型每一轮都坚持只思考，3 次之后插件会放行，用户仍会看到空白回复 —— 这是刻意的防死循环设计。
- 节选会先 `trim()` 掉首尾空白；`reasoningExcerptChars` 按 JS 字符串长度算（中文正常，emoji 之类按 2 计）。
- 节选原文若自身含 `>>>`，格式会略乱（不影响模型理解，没做转义）。
- 依赖 `agent/turn-stopping` 在 `turn()` 判空 `break` 之前派发；若上游改了触发时机需要重新核对。
