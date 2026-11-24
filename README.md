# dsh-stop-only-guard

DSH（DeepSeek Harness）插件：把「整轮只在思考里走完、正文是空的、却算正常结束」的轮次救回来。

配套的 **`dsh-guard-hide`** 把补救时注入的那条消息从聊天界面藏掉——模型照收，人不被打断。

> 不是官方插件。问题出在 `dsh-agent-loop` 的判定上，哪天上游自己修了，这个包就该退休。

## 症状

`deepseek-flash` 偶尔一整轮只在 reasoning（思考）通道里输出，最后一帧是：

```json
{ "type": "finish", "reason": { "kind": "stop" } }
```

这条 `assistant/message` 的 `content` 里**只有 reasoning**，没有 text，也没有 tool-call。
`dsh-agent-loop` 的 `step()` 只看消息里有没有 tool-call，没有就 `return { kind: 'completed' }`——
这一轮被当成正常收尾，循环退出，界面上只剩一条空白回复。

它跟这些都不是一回事：

- 不是网络断、不是超时（`llm-retry` 接不住：请求确实成功了）
- 不是 `tool-calls` 却缺 tool-call（那是 `dsh-empty-turn-guard` 管的那种）
- 重试也没用：同一个 prompt 再来一次，它可能照样只想不说

实测里它跟「这一场聊了多久」有关——聊到四五个钟头之后掉得越来越勤。flash 掉得密，pro 也掉。

## 它怎么救

在 `agent/turn-stopping` 上插一脚：四条判定全中，就往 `inbox.next-step` 塞一句话，
让同一个 turn 再开一步，模型就被推着把话写出来。

注入的话里带着**被吞那轮的思考节选**（默认最多 600 字），所以模型是接着自己原来的思路补，
而不是凭空重说一段：

```
[stop-only-guard] 上一轮你只在思考里走完了、正文是空的。你当时的思考（节选）：
<<<
（reasoning 原文）
>>>
请接着这段把正文补出来，不要只思考。
```

拿不到 reasoning 时退回一句短的默认文案。

### 判定条件（四条全中才救）

1. 该 attempt 的 `finish.reason.kind === 'stop'`
2. 内容块里没有 text、也没有 tool-call（只有 reasoning，或除 usage/finish 外完全为空）
3. 当前 `turn-stopping` 的 `turn` 就是这个 attempt 的 turn
4. `signal.aborted` 为假

另外该 attempt 的 `end.outcome.kind` 必须是 `committed`——报错、取消、abandoned 一律放行。

### 安全设计（fail-open）

- 每个监听器里 `try/catch`，异常只记日志。`agent/turn-stopping` 是 `serial` 派发，抛错会把整轮变 error，这条是硬要求。
- `aborted` 为真时绝不复活轮次。
- 双重上限防死循环：每 turn 最多 3 次、每 agent 最多 30 次，到顶就放行（用户会看到空白，这是故意的）。
- 纯内存状态（`WeakMap`），不写文件、不联网、零运行时依赖。

## 两个包

| 包 | 目录 | 作用 |
| --- | --- | --- |
| `dsh-stop-only-guard` | `packages/dsh-stop-only-guard` | Host 半身：判定 + 注入 |
| `dsh-guard-hide` | `packages/dsh-guard-hide` | Client 半身：把注入的消息在界面上藏起来 |

两个可以分开装。只装第一个也能救，只是界面上会看见一条 `[stop-only-guard] …` 的用户消息。

## 装法（本地包）

以 profile 目录 `<profile>`（例如 `~/.dsh/profiles/desktop`）为例：

```powershell
# 1. 源码放到 <profile>\vendor\ 下，两个目录各一份
# 2. 在 <profile>\node_modules 里建 junction 指向它们
New-Item -ItemType Junction -Path "<profile>\node_modules\dsh-stop-only-guard" -Target "<profile>\vendor\dsh-stop-only-guard"
New-Item -ItemType Junction -Path "<profile>\node_modules\dsh-guard-hide"        -Target "<profile>\vendor\dsh-guard-hide"

# 3. <profile>\package.json：
#    dependencies 里各加一行
#      "dsh-stop-only-guard": "file:./vendor/dsh-stop-only-guard"
#      "dsh-guard-hide": "file:./vendor/dsh-guard-hide"
#    dsh.profile.bundles 里各加一行包名
#
# 4. <profile>\cordis.patch.yml 末尾照「配置」一节加一条覆盖（可选）
```

两个包都带自己的 `cordis.patch.yml`（`insert` 一行），所以只加 bundles 就能挂上。
Loader 的 patch 方言里，非 `insert` 的 patch 必须命中已存在的行，否则 warn + 跳过——
这也是为什么「只在 profile 里写一条按 id 的 config」不够，包自带的 `insert` 不能少。

改完 profile 文件后，DSH 的 profile HMR 会重新组合（`cordis.patch.yml` 和 `package.json` 都在监视列表里），
通常不用重启。若报 `restart required`，重启一次。

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

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 时连监听器都不注册 |
| `maxRemediesPerTurn` | `3` | 同一 turn 内最多补救几次；`0` = 不限 |
| `maxRemediesPerAgent` | `30` | 单个 agent 生命周期内最多补救几次；`0` = 不限 |
| `reasoningExcerptChars` | `600` | 注入里带多少字思考节选；`0` = 不带 |
| `log` | `true` | 用 `ctx.logger.warn` 记录命中与放行 |

## 怎么确认它真的在干活

1. 日志里出现 `[stop-only-guard] turn N step M 命中（stop-only …），已注入第 1 次补救（…）`
2. 会话里立刻多出一条 `[stop-only-guard]` 开头的用户消息，紧接着应当有正常的助手正文

## 跟别的守护插件什么关系

不装原创。DSH 生态里已经有一批处理「空轮次 / 空回复」的插件，各管各的形态：

| 插件 | 管的形态 |
| --- | --- |
| `dsh-empty-turn-guard` | `finish=tool-calls` 却没有 tool-call |
| `dsh-reasoning-only-guard` | 只有 reasoning 时塞一段占位文本（不重新生成） |
| `dsh-llm-retry` | 请求层面的失败重试（管不到「成功了但没正文」） |
| **本包** | `finish=stop`、无 text 无 tool-call，且**要模型重新生成正文** |

如果你要的只是「别空白」，`dsh-reasoning-only-guard` 那类就够；本包的差别是**它会让模型接着说**。

## 自检

第一个包带离线自检（不启动 DSH、不联网）：

```powershell
node packages/dsh-stop-only-guard/selftest.mjs
# 期望最后一行：VERDICT: OK
```

用假 ctx / 假 agent 回放帧序列，覆盖判定表、主路径、6 种不该救的形态、双重上限、aborted、
turn 不一致、abandoned、异常 payload、steer 抛错、多 agent 隔离、日志开关、
以及思考节选的截断与回退。

## 已知边界

- 只救 `finish.reason.kind === 'stop'`；`max-tokens`、`tool-calls`、`error`、`aborted` 一概不动。
- 救回来的那一步会多消耗一次模型调用（所以有上限）。
- 模型要是每轮都坚持只思考，3 次之后会放行，用户仍会看到空白——防死循环，故意的。
- 节选先 `trim()`；长度按 JS 字符串算（emoji 按 2 计）。
- 节选原文若自身含 `>>>`，格式会略乱（不影响理解，没做转义）。
- 依赖 `agent/turn-stopping` 在 `turn()` 判空 `break` 之前派发；上游改了时机要重新核对。

## 许可

MIT。
