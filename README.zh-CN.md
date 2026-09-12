# pi Ledger Context 扩展

Ledger Context 将有界的 active ledger 保存到 pi 会话日志，并在下一次原生上下文压缩时带入确定性恢复 bootstrap。扩展使用 pi 的公开 ExtensionAPI 和 SDK。

## 运行前提

- 运行基线为 `@earendil-works/pi-coding-agent` 0.85.1，要求 Node.js `>=22.19.0`。
- 自动切窗使用 pi 原生自动压缩。压缩阈值、会话日志、steering 和 follow-up 队列、overflow 重试以及压缩生命周期由 pi 管理。
- 每个会话配置一个 compaction 内容扩展。Ledger Context 提供压缩摘要和恢复 bootstrap，使每个窗口拥有唯一的权威内容来源。
- 关闭原生自动压缩时，`checkpoint`、`history_read`、`history_search` 和手动 `/compact` 仍可用。

## 安装

在 checkout 根目录将此包作为本地 pi 包安装，包 manifest 加载 `src/ledger-context.ts`：

```bash
pi install -l .
```

包只暴露一个扩展入口，并注册以下模型工具：

- `checkpoint` 保存完整 active ledger，回报持久化范围和 handoff 状态。
- `history_search` 在当前分支执行区分大小写的字面搜索。
- `history_read` 读取当前分支指定 entry 的有界正文。

## checkpoint 与窗口

使用 `checkpoint` 提交完整 active ledger，以及可选的当前分支用户 request entry ID。成功回执包含 checkpoint entry ID、来源窗口 ID、请求历史位置、ledger 大小估计、持久化范围和 `awaiting-native-compaction-threshold` handoff 状态。

checkpoint 完成 handoff 准备后继续当前 run。pi 在原生阈值达到时决定切窗。自动压缩和手动 `/compact [instructions]` 共用 Ledger Context bootstrap 路径，手动路径不执行独立摘要模型请求。

持久会话的回执在重新打开会话日志后继续可用。内存 SDK 会话的回执覆盖当前进程，重启恢复需要持久会话。

bootstrap 携带最新 ledger、当前任务和最新用户措辞、窗口元数据、有界近期交互、执行状态及历史引用。assistant tool call 与 tool result 保持配对。持久会话将完整 entry 保存在 pi 会话日志中作为证据来源，内存会话在当前进程中保留这些 entry。

## 历史恢复

使用 `history_search` 提交区分大小写的字面 `query`，再将返回的 `entryId` 交给 `history_read`。搜索结果包含来源角色、已提交窗口、执行状态、匹配位置、稳定引用和 `nextCursor`。`history_read` 通过 `offset`、`length` 和 `nextOffset` 分页返回有界正文。

查询范围始终是当前会话分支；窗口和角色过滤器可以继续收窄范围。图像 payload 返回元数据与稳定引用，编码正文保持在历史日志中。

## 配置与预算

七项扩展配置均使用 `LEDGER_CONTEXT_` 命名空间。所有覆盖值都必须是正整数，且 `LEDGER_CONTEXT_URGENT_TOKENS` 小于 `LEDGER_CONTEXT_REMINDER_TOKENS`。

urgent 默认值使用默认 soft 阈值；覆盖 soft 阈值时同时设置匹配的 urgent 阈值。

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `LEDGER_CONTEXT_REMINDER_TOKENS` | `max(2, floor(min(window × 0.20, 32768)))` | soft reminder 的剩余 token 预算 |
| `LEDGER_CONTEXT_URGENT_TOKENS` | `max(1, min(default soft threshold − 1, floor(min(window × 0.10, 16384))))` | urgent reminder 的剩余 token 预算 |
| `LEDGER_CONTEXT_LEDGER_TOKENS` | `4096` | 已保存 ledger 的估计 token 上限 |
| `LEDGER_CONTEXT_TASK_TOKENS` | `4096` | 任务和 request 恢复文本的估计 token 上限 |
| `LEDGER_CONTEXT_TAIL_TOKENS` | `4096` | 近期交互显示的估计 token 上限 |
| `LEDGER_CONTEXT_READ_TOKENS` | `2048` | 单次历史工具结果的估计 token 上限 |
| `LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS` | `max(1, floor(min(window × 0.10, 16384)))` | 每次保守请求预算中预留的输出空间 |

每次请求预算都包含实际 system prompt、活动工具 schema 及 prompt guidelines、模型 metadata、选中的恢复内容和 output reserve。ledger 还受固定的 `65,536` UTF-8 字节上限约束，active request 引用最多 `8` 个。history search 的 query 最多 `8,192` 字节，identifier 最多 `1,024` 字符，每页最多 `100` 条结果，每次读取最多 `65,536` 字符。

provider 用量未知时显示 unknown，并依据可见内容生成有界估计，估计值受模型窗口限制。极小窗口无法容纳固定上下文和最小恢复 metadata 时进入明确容量错误路径，并通过 `ctx.abort()` 停止当前请求。

## 恢复状态

- checkpoint 缺失或落后于新工作的 stale 状态时，bootstrap 明确给出恢复范围和历史引用；模型可以先搜索和读取完整当前分支，再继续有副作用的动作。
- compaction 正常取消或 checkpoint 输入无效时，上一有效窗口和 checkpoint 保持可用。
- 持久会话日志写入失败时，当前 run 及后续保存和切窗停止。使用新的公开 `SessionManager` 重新打开持久文件；普通 extension reload 保留失败的内存分支，无法完成恢复。
- fork、tree、resume、reload、new session 和模型切换都沿选中分支重建状态，每条分支保留自己的 ledger 与窗口记录。
