# pi Ledger Context 扩展

Ledger Context 将有界的工作账本保存到 pi 会话日志，并在原生上下文压缩时带入确定性的恢复引导（bootstrap）。扩展使用 pi 的公开 `ExtensionAPI` 和 SDK。

## 运行前提

- 运行基线为 `@earendil-works/pi-coding-agent` 0.85.1，要求 Node.js `>=22.19.0`。
- 开启 pi 原生自动压缩以自动切换上下文窗口。pi 管理压缩阈值、会话日志、插入消息（steering）和后续消息（follow-up）队列，以及上下文溢出重试和压缩生命周期。
- 每个会话配置一个压缩内容扩展。Ledger Context 为每个窗口提供压缩摘要和恢复引导。
- 关闭原生自动压缩时，`checkpoint`、`history_read`、`history_search` 和手动 `/compact` 仍然可用。

## 安装

在源码目录将此包作为本地 pi 包安装，包清单加载 `src/ledger-context.ts`：

```bash
pi install -l .
```

包注册以下模型工具：

- `checkpoint` 保存完整工作账本，并回报持久化范围和交接状态。
- `history_search` 在当前分支执行字面搜索，默认忽略大小写；`caseSensitive: true` 要求大小写一致。
- `history_read` 读取当前分支指定条目的有界正文，或选取一个图像。
- `history_list_items` 浏览当前分支条目与 checkpoint 版本，支持无关键词列举。
- `history_list_windows` 列出初始窗口和已提交窗口，包含归属条目数为零的窗口。
- `get_context_remaining` 返回模型余量、有效边界余量、输出预留及用量来源。

## 检查点与恢复

使用 `checkpoint` 提交完整工作账本，以及可选的当前分支用户请求条目 ID。成功回执包含检查点条目 ID、来源窗口 ID、请求历史位置、账本大小估计、持久化范围和 `awaiting-native-compaction-threshold` 交接状态。

账本保持简短，记录目标和状态、约束和决策、已验证的结果及证据、下一步或等待条件、恢复引用，以及适用的可用技能或“无”。细节通过路径和条目 ID 引用，计划与已完成工作分别标明，敏感信息使用脱敏表示。

恢复引导标出上一个检查点、最新用户请求和最新已完成的助手回答。`requestHistoryPosition` 记录生成检查点的模型请求开始时的日志位置，`pendingHistoryRange` 标出此后的事件。这些位置用于定位证据，不能证明证据已经读取、理解或反映到账本中。继续执行有副作用的操作前，结合已保留的正文或按需读取缺失条目来核验工作状态。

保存检查点后，当前运行继续执行。pi 控制压缩时机。每次自动压缩和手动 `/compact [instructions]` 都使用当前模型、宿主认证、上一个可用账本、最新任务及后续有界历史更新账本。暂时性网络或服务错误、限流，以及空输出、截断、超预算或校验失败，共享最多三次生成尝试，并使用可取消的退避等待。认证、请求格式和账户额度错误直接进入恢复流程。每次尝试持续等待响应或错误，期间可由用户取消。有效结果保存一次为检查点并用于恢复。生成失败时，恢复上一个可用检查点，同时明确提醒账本可能过期，并提供恢复引用。该检查点不可用或超过当前账本预算时，恢复引导明确要求从会话历史恢复状态。用户取消会取消压缩；检查点写入失败时停止恢复，需重新打开持久会话。

恢复引导携带最新账本、当前任务和最新用户措辞、窗口元数据、有界近期交互、执行状态及直接历史引用。助手工具调用与每一个匹配的工具结果保持配对。持久会话将完整条目保存在 pi 会话日志中作为证据来源，内存会话在当前进程中保留这些条目。

已知条目 ID 时先使用 `history_read`。证据尚未定位时使用 `history_search`，再读取返回的 ID。找齐下一步所需证据后即可结束历史检索。

## 提醒与原生边界

Ledger Context 从活动检查点的请求位置统计新增工作量；窗口没有检查点时从当前窗口起点统计。普通用户消息、助手工作和工具交互计入工作量。检查点、历史工具、容量查询和提醒等维护活动不计入工作量，但仍占用请求容量。体积提醒的间隔为当前模型上下文窗口的 10%，向下取整且至少为一个 token。每跨过一个新区间排队一条提醒；大型结果跨过多个区间时，只按最高到达位置提醒一次。已提醒的位置在重载后保留；模型变化时重新计算间隔，并保留已提醒进度。检查点成功后重置计量起点。`LEDGER_CONTEXT_TAIL_TOKENS` 独立控制历史保留量。

提醒由累计工作量或预算压力触发。工具批次结束后，通过 pi 原生消息插入机制投递；当前运行已经结束时，待处理提醒留到下一次正常用户请求。多个原因合并为一条提醒，各原因分别去重。提醒投递期间，普通工作继续执行。

已知原生设置使用有效边界 `B = min(W - O, W - R)`，其中 `W` 是模型窗口，`O` 是扩展输出预留，`R` 是 pi 原生压缩预留。原生设置关闭或未知时使用带窗口保护的 `B = W - O`。两项提醒配置表示相对 B 的提前量。因此 `W=500000`、`O=16384`、`R=27200` 时，`B=472800`；默认柔性和紧急提醒的已用 token 触发值分别为 `440032`（`B - 32768`）和 `456416`（`B - 16384`），对应提前量分别为 `32768` 和 `16384` token。

包通过公开 `SettingsManager`，按当前工作目录、agent 目录和项目信任状态读取原生设置。SDK 宿主可通过 `settingsReader` 提供实际配置。下例中的 `settingsManager` 是宿主已有实例；构造宿主的资源加载器时，将 `ledgerExtension` 加入构造选项 `extensionFactories`：

```ts
import { createLedgerContext } from "./src/ledger-context.ts";

const ledgerExtension = createLedgerContext({
  settingsReader: () => ({
    source: "host SettingsManager",
    compaction: settingsManager.getCompactionSettings(),
  }),
});
```

设置读取失败时，原生边界标记为未知，并采用窗口保护。模型、工作目录和配置变化会重新计算边界。

## 历史恢复

`history_search` 搜索连续的字面子串，默认忽略大小写；设置 `caseSensitive: true` 时要求大小写一致。结果按从新到旧排列，包含有界摘录和 `nextCursor`，摘录保留原文及其偏移。`scope` 默认为 `conversation`，搜索用户和助手正文；`tools` 搜索普通工具调用和结果；`checkpoints` 搜索已保存的 ledger 正文；`all` 包含所有可搜索条目。窗口、角色和 `hasImage` 过滤器限定当前分支中的范围，`hasImage` 根据原始图像块是否存在筛选。游标保留原始快照及过滤条件，并限定在生成它的工具内使用。

`history_list_items` 接受相同的 scope、窗口、角色、图像、条数和游标过滤条件，默认使用 `scope: "all"`。结果从新到旧排列，包含纯图片消息，并返回工具调用配对元数据与图像引用。Checkpoint 结果还包含前一个可解析版本的 ID、来源窗口、请求历史位置和相对于快照的 `active` 标记。`fitsCurrentLedgerBudget` 检查 checkpoint 格式与当前 ledger 预算，完整 bootstrap 容量在压缩时检查。预算缩小后，旧 checkpoint 仍可被发现，并可通过 `history_read` 读取完整内容。

`history_list_windows` 接受 `limit` 和 `cursor`，返回在分页快照内稳定的窗口身份、归属条目数、首尾条目 ID，以及按原始来源窗口统计的 checkpoint 数量和最新 ledger 的有界预览。保留的尾部条目沿用现有已提交窗口归属规则。历史列表与读取、搜索共同使用 `LEDGER_CONTEXT_READ_TOKENS` 输出预算。

`get_context_remaining` 提供只读容量快照：`modelRemainingTokens` 表示模型窗口余量，`tokensUntilBoundary` 表示有效边界前的余量；`usageKind` 区分 pi 用量、估算和不可用状态，不可用的数值为 null。Pi 管理压缩时机。

`history_read` 接受 `offset` 和 `length` 对正文分页，在仍有后续内容时返回 `nextOffset`。偏移和长度均以 UTF-16 代码单元计量。结果包含来源角色、窗口、执行状态、条目引用和载荷引用。会话日志保留完整原始条目。

列表和搜索结果中的工具调用配对元数据按输出预算截取。`omittedToolCalls` 表示该元数据省略的调用数量；通过条目 ID 调用 `history_read` 可读取完整调用详情。

### 图像读取

向 `history_read` 传入 `imageIndex`，选择源条目 `content` 数组中的原始图像块下标。该下标映射到 `pi://entry/<id>/content/<index>`。图像模式与 `offset`、`length` 互斥。成功调用返回一个规范化 `ImageContent`、有界来源说明，以及包含来源条目、窗口、尺寸、MIME 类型和编码前后大小的来源信息。

图像读取需要支持图像输入的模型和有效图像字节。pi 的公开图像工具将副本规范化至最多 2000×2000 像素，base64 载荷小于 4.5 MiB。图像无效、来源不可用、模型不支持图像或容量不足时，返回带来源引用的明确文本错误。

符合请求预算的图像会出现在紧接的下一次实际模型请求中，包括发生原生压缩，或同批包含大型普通工具结果和多个图像读取的情况。每个工具调用均保留匹配结果。无法容纳的图像会在该请求中替换为带来源引用的文本错误。若连包含这些错误和必需上下文的最小请求也无法容纳，运行会因容量错误而停止。后续请求可用元数据引用表示已投递的图像。

使用 `openai-responses` 时，请求中的工具图像以 user 内容附在完整工具结果批次之后，并标明来源调用 ID。工具结果保留文字和调用配对，会话日志保留原始图像块。

## 配置与预算

七项扩展配置均使用 `LEDGER_CONTEXT_` 命名空间。所有覆盖值都必须是正整数，且 `LEDGER_CONTEXT_URGENT_TOKENS` 小于 `LEDGER_CONTEXT_REMINDER_TOKENS`。

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `LEDGER_CONTEXT_REMINDER_TOKENS` | `max(2, floor(min(window × 0.20, 32768)))` | 柔性提醒在有效边界前的提前量；已用 token 触发值为 `B - 提前量` |
| `LEDGER_CONTEXT_URGENT_TOKENS` | `max(1, min(默认柔性提醒提前量 − 1, floor(min(window × 0.10, 16384))))` | 紧急提醒在有效边界前的提前量；已用 token 触发值为 `B - 提前量` |
| `LEDGER_CONTEXT_LEDGER_TOKENS` | `4096` | 已保存账本的估计 token 上限 |
| `LEDGER_CONTEXT_TASK_TOKENS` | `max(1, floor(window × 0.05))` | 任务和请求恢复文本的估计 token 上限 |
| `LEDGER_CONTEXT_TAIL_TOKENS` | `max(1, floor(window × 0.05))` | 近期交互显示的估计 token 上限 |
| `LEDGER_CONTEXT_READ_TOKENS` | `2048` | 单次 `history_read` 或 `history_search` 结果的总估计输出上限；图像读取还包含来源元数据、说明文字和图像估计 |
| `LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS` | `max(1, floor(min(window × 0.10, 16384)))` | 每次保守请求预算中预留的输出空间 |

每次请求预算都包含系统提示、活动工具定义及提示指南、模型元数据、选中的消息和恢复内容，以及输出预留。完整请求能够容纳时，当前必需的工具调用与结果、刚读出的图像可以超过近期交互上限；可选历史内容仍受分配额度约束。图像读取同时遵守 `LEDGER_CONTEXT_READ_TOKENS` 总量限制。

账本最多包含 `65,536` 个 UTF-8 字节和 `8` 个活动请求引用。历史查询最多包含 `8,192` 个 UTF-8 字节，标识符最多包含 `1,024` 个 UTF-16 代码单元，每页搜索结果最多 `100` 条。正文读取接受的最大长度为 `65,536` 个 UTF-16 代码单元。这些输入限制与输出预算共同生效。

pi 的上下文用量由提供方报告的用量与后续消息的估算量组成。提供方用量未知时，Ledger Context 根据请求中的有界消息、系统提示、活动工具定义和模型元数据估算用量；完整请求容量另计输出预留。文本和图像估算用于容量决策，其精度取决于模型的 token 计量方式。

## 恢复状态

- 每次压缩都尝试更新账本；更新失败时，明确标识恢复的检查点或从历史恢复的状态。
- 压缩正常取消和无效检查点输入保留上一有效窗口和检查点。
- 持久会话日志写入失败时，当前运行及后续保存和切窗停止。使用新的公开 `SessionManager` 重新打开持久文件以继续持久恢复。
- `fork`、`tree`、`resume`、`reload`、新会话和模型切换都沿选中分支重建状态，每条分支保留自己的账本、窗口记录和待处理提醒来源。
