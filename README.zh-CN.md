# pi Ledger Context 扩展

Ledger Context 在 pi 会话日志中保存主 agent 的工作 checkpoint 和独立的累计 compaction delta，通过 pi 的公开 `ExtensionAPI` 和 SDK 为每次模型请求提供当前恢复基线。

## 运行前提

- 运行基线为 `@earendil-works/pi-coding-agent` 0.86.0，要求 Node.js `>=22.19.0`。
- 开启 pi 原生自动压缩以自动切换上下文窗口。pi 管理压缩阈值、会话日志、插入消息（steering）和后续消息（follow-up）队列，以及上下文溢出重试和压缩生命周期。
- 每个会话配置一个压缩内容扩展。Ledger Context 为每个窗口提供压缩摘要和恢复引导。
- 关闭原生自动压缩时，六个模型工具和手动 `/compact` 仍然可用。

## 安装

在源码目录将此包作为本地 pi 包安装，包清单加载 `src/ledger-context.ts`：

```bash
pi install -l .
```

包注册以下模型工具：

- `checkpoint` 保存完整工作账本，并回报持久化范围和交接状态。
- `history_search` 在选中的历史内容中查找字面文本，返回来源引用与匹配位置。
- `history_read` 读取条目、原始内容块、单张图片、工具调用过程或邻近日志条目。
- `history_list_items` 按条件浏览条目和 checkpoint 版本，返回有界预览。
- `history_list_windows` 提供窗口导航、过滤统计、用户措辞和 ledger 摘录。
- `get_context_remaining` 返回模型余量、有效边界余量、输出预留及用量来源。

## 检查点与恢复

使用 `checkpoint` 提交当前完整工作状态，以及可选的当前分支用户请求条目 ID。将当前 checkpoint、后续 delta 和近期工作中仍需保留的事实整理进去。成功保存后替换活动基线，旧版本保留在历史中；回执标明条目 ID、来源窗口、请求位置、大小和持久化范围。Pi 控制压缩时机。

账本保持简短，记录目标和状态、约束和决策、已验证的结果及证据、下一步或等待条件、恢复引用，以及适用的可用技能或“无”。细节通过路径和条目 ID 引用，计划与已完成工作分别标明，敏感信息使用脱敏表示。

Checkpoint 由主 agent 的 `checkpoint` 工具写入，其提示要求整理当前工作状态。压缩提示要求描述此后的变化：用户更正、决策、执行结果、验证和下一步的变化。生成器接收只读 checkpoint、作为摘要的上一份匹配 delta，以及有界的新证据。连续压缩更新累计 delta，保留 checkpoint 原文。尚无 checkpoint 时，delta 从分支起点开始。

恢复记录使用 schema version 4。从较早的恢复协议切换时，请新建会话。原始日志保持完整；协议不匹配或恢复记录损坏时，恢复过程会明确报错并停止。

`inputCoverage` 是不可变的输入记录。Agent checkpoint 使用 `measurement: "unmeasured"`、`source: "agent-context"`、`snapshotThrough` 和 `recoveryBasis`；后者记录生成它的主请求中投影的 checkpoint/delta ID，没有恢复视图时为 null。Delta 请求使用 `measurement: "measured"` 和 `source: "compaction-delta"`，包含以下字段：

| 字段 | 含义 |
| --- | --- |
| `measurement`、`source`、`snapshotThrough` | 测量可用性、生成路径和请求快照末端，所有输入记录均包含这些字段。 |
| `baseCheckpointEntryId`、`baseDeltaCompactionEntryId` | 实际作为基础输入提供的 checkpoint 和早期生成 delta 的来源 ID，或 null。 |
| `historyScope` | 已测量请求的历史选择区间：从 `afterEntryId` 之后，到包含 `throughEntryId` 为止；下界为 null 表示从分支起点开始。 |
| `representation` | `rendered-text-with-image-references`：提供的文字包含图片引用；像素通过独立图像读取获取。 |
| `fullRanges` | 本次 delta 请求完整提供了渲染正文的条目范围，包含首尾条目。 |
| `partialEntries` | 原始渲染正文的前缀：来源条目 ID、正数 `providedChars` 和更大的 `totalChars`，单位为 UTF-16。 |
| `projections` | `reference`、`checkpoint-ledger`、`delta-ledger` 或 `filtered-entry`，记录来源 ID 和投影文字已提供/总 UTF-16 长度。 |
| `omittedRanges` | `historyScope` 内未选入有界输入的范围，包含首尾条目和条目数。 |
| `excludedRanges` | 按固定规则排除的 `maintenance` 或 `structural-metadata` 范围；包含实质证据的历史工具结果仍参与选择。 |

Delta 的 `scope` 表示累计目标区间，输入记录的 `historyScope` 表示本次考虑的新历史区间。任务锚点可以位于该区间之前。旧 delta 正文记录为摘要投影，其原始来源继续保留各自早期的输入记录。任务相关性、理解和核验由 agent 在正常工作中结合证据判断。

生成输入显式提供基础 checkpoint 和上一份 delta。完整 compaction 包和输入清单保留在日志中，使连续生成的输入保持有界。混有维护工具调用的 assistant 消息使用过滤投影；普通证据保留自身的渲染内容，包括其中的引文。

回执、列表和恢复视图展示简短的 `inputRecord` 来源信息。通过 `history_read` 读取 checkpoint 或承载 delta 的 compaction 条目，并跟随 `nextRead` 获取完整细节。生成的 delta 记录提供可选的来源浏览调用，定位未选入范围、部分原文和投影来源。Agent 根据当前任务选择证据。

压缩后，每次主 agent 请求将最新 checkpoint 及其匹配 delta 投影到本扩展的恢复摘要中。新 checkpoint 立即成为基线，早期 checkpoint/delta 版本继续保留在历史中。持久化 compaction 包及其有界 task/tail 材料保持原样；投影前根据当前分支核对恢复记录归属。

Delta 使用当前模型和宿主认证生成。暂时性错误和无效输出共享最多三次尝试，并使用可取消的退避等待；认证、请求格式和账户额度错误直接进入恢复流程。每次尝试等待响应或错误，期间可由用户取消。没有新增合格材料或 custom instructions 时，压缩复用匹配 delta 或记录 empty 状态。新 delta 随 pi compaction 条目提交后生效。

恢复视图区分保存的状态与后续变化。后续用户更正和原始执行证据可以修正旧事实；delta 没提及某项时，checkpoint 中的该项仍然保留。`requestHistoryPosition` 和 `compactionSnapshot` 标明请求边界，`eventsAfterDeltaInput` 为按需调查定位后续事件。这些字段描述来源，agent 决定需要核验什么。工具调用保留匹配结果，完整来源条目保留在会话日志中。

已知条目 ID 时使用 `history_read`。需要定位证据时，浏览窗口和条目，或按已知关键词搜索，再读取返回的 ID。检索范围以支持下一步操作所需的证据为准。

## 提醒与原生边界

Ledger Context 从当前分支最新 agent checkpoint 的请求位置与最近一次已提交 compaction 中较晚的位置之后统计新增工作量；两者均无时从分支起点统计。保留历史和恢复材料位于新窗口的计量起点之前，checkpoint 的来源记录保持原样。工作量统计覆盖普通用户消息、助手工作和普通工具交互。请求容量同时包含 checkpoint、历史工具、容量查询和提醒等维护活动。体积提醒的间隔为当前模型窗口的 10%，向下取整且至少一个 token。每跨过一个新区间排队一条提醒；大型结果跨过多个区间时按最高位置提醒一次。已提醒的位置在所属窗口和 checkpoint 起点内跨重载保留；模型变化时重新计算间隔并保留已提醒进度。`LEDGER_CONTEXT_TAIL_TOKENS` 独立控制历史保留量。

提醒由累计工作量或预算压力触发。工具批次结束后，通过 pi 原生消息插入机制投递；当前运行已经结束时，待处理提醒留到下一次正常用户请求。每次模型请求前重新检查适用性：窗口或 checkpoint 起点变化后，旧 volume 提醒失效；budget 提醒按当前余量和紧急程度更新。每种原因在请求中至多保留一条有效提醒。原始提醒记录保留在日志中供追溯，当前提醒文案仅投影到本次请求。提醒投递期间，普通工作继续执行。

已知原生设置使用有效边界 `B = min(W - O, W - R)`，其中 `W` 是模型窗口，`O` 是扩展输出预留，`R` 是 pi 原生压缩预留。原生设置关闭或未知时使用带窗口保护的 `B = W - O`。两项提醒配置表示相对 B 的提前量。因此 `W=500000`、`O=16384`、`R=27200` 时，`B=472800`；默认柔性和紧急提醒的已用 token 触发值分别为 `440032`（`B - 32768`）和 `456416`（`B - 16384`），对应提前量分别为 `32768` 和 `16384` token。

包通过公开 `SettingsManager`，按当前工作目录、agent 目录和项目信任状态读取原生设置。SDK 宿主可通过 `settingsReader` 提供实际配置。下例中的 `settingsManager` 是宿主已有实例；构造宿主的资源加载器时，将 `ledgerExtension` 加入构造选项 `extensionFactories`：

```ts
import { createLedgerContext } from "./src/ledger-context.ts";

const ledgerExtension = createLedgerContext({
  settingsReader: (ctx) => ({
    source: "host SettingsManager",
    compaction: settingsManager.getCompactionSettings(ctx.model ?? undefined),
  }),
});
```

设置读取失败时，原生边界标记为未知，并采用窗口保护。模型、工作目录和配置变化会重新计算边界。

## 历史恢复

历史查询工具共用结构化 `filter`。不同字段按 AND 组合，同一数组内的值按 OR 组合，`excludeKinds` 优先。查询范围限定在当前会话分支。

| 过滤条件 | 含义 |
| --- | --- |
| `kinds`、`excludeKinds` | 选择或排除 `user_input`、`assistant_text`、`tool_call`、`tool_result`、`checkpoint`、`compaction_delta`、`metadata` 内容。省略时包含全部种类。 |
| `toolNames` | 精确工具名，选择对应调用和结果。 |
| `statuses` | 日志执行状态：`received`、`requested`、`completed`、`failed`、`saved`、`committed`、`metadata`。 |
| `windowIds` | 已提交窗口或初始窗口的 ID。 |
| `afterEntryId`、`beforeEntryId` | 分支快照内的排他位置范围。 |
| `hasImage` | 按原始图像块是否存在筛选条目。 |
| `includeMaintenance` | 包含 checkpoint、历史查询、容量查询工具的调用与结果，默认 false；保存的 checkpoint 记录独立参与筛选。 |

`history_list_items` 和 `history_search` 每个原始 entry 返回一项，标明选中的 `kinds`、执行状态和来源 ID。搜索要求非空字面 `query`，默认忽略大小写，`caseSensitive: true` 启用精确大小写。匹配与返回内容独立：`projection` 默认 `all`，返回文字预览和图像引用；`text` 返回选中内容中的文字，保留带图条目的文字；`images` 返回图像引用；`references` 返回条目元数据。`maxChars` 控制每条预览的上限，默认 256 个 UTF-16 代码单元。搜索报告匹配内容的原始 `contentIndex` 和所选渲染文本内的偏移；图片通过文字元数据参与匹配。

条目列表和搜索结果包含 `items`、`totalMatches`、`returnedCount`、`snapshotThrough` 和 `nextCursor`。`order` 默认 `newest`，也支持 `oldest`。Version 4 游标绑定分支快照、工具、过滤条件、顺序和匹配选项。续页保持相同的选择参数，允许调整 `limit`、`maxChars` 和 `projection`；后续活动保持该快照稳定。`limit` 和 `maxChars` 是输出预算内的上限。`pageEnd` 表示 `complete`、`limit` 或 `output_budget`；预览的截断标记提供完整条目的读取方向。无效游标会说明如何续页，以及如何从当前查询重新开始。

Checkpoint 结果包含前一个可解析版本的 ID、来源窗口、请求位置和快照内的 `active` 标记。预算缩小后，最新 checkpoint 保留身份，由 `fitsCurrentLedgerBudget` 报告能否容纳。压缩和每次请求均检查完整恢复容量。`compaction_delta` 结果标明生成 delta 的 compaction 条目、基础 checkpoint、范围、输入记录和活动标记；复用或过期 delta 引用其原始条目。

`history_list_windows` 接受共用过滤条件、顺序、条数和游标，包含初始窗口及条目数为零的已提交窗口。`entryCount` 和首尾条目 ID 描述原生窗口归属；`matchedEntryCount`、`kindCounts`、`failedToolResults`、`imageCount` 使用与条目列表相同的过滤条件。工具调用按调用数统计，其他种类按条目数统计。最新用户预览引用匹配的输入原文；checkpoint 数量、摘录和最新输入记录的来源信息独立于过滤条件，按原始来源窗口组织。预览截断标记区分完整措辞与摘录。续页保持 filter/order，可调整 `limit`；`returnedCount` 和 `pageEnd` 描述本页状态。成功返回的历史结果遵守 `LEDGER_CONTEXT_READ_TOKENS` 预算。

窗口独立展示 `deltaStatus`、`deltaActive`、承载 delta 的 compaction ID、基础 checkpoint、预览和 `deltaInputRecord`。Checkpoint 数量统计主 agent 保存的版本；新 checkpoint 生效后，窗口已提交的 delta 状态继续作为历史信息保留。

```ts
history_search({ query: "timeout", filter: { kinds: ["tool_result"], toolNames: ["bash"], statuses: ["failed"] }, projection: "text" });
history_list_items({ filter: { kinds: ["checkpoint"] }, limit: 5 });
history_list_items({ filter: { kinds: ["compaction_delta"] }, limit: 5 });
history_read({ entryId: "result-id", view: "exchange" });
```

`get_context_remaining` 提供只读容量快照：`modelRemainingTokens` 表示模型窗口余量，`tokensUntilBoundary` 表示有效边界前的余量；`usageKind` 区分 pi 用量、估算和不可用状态，不可用的数值为 null。Pi 管理压缩时机。

`history_read` 默认使用 `view: "entry"`，接受 `projection`、可选的原始 `contentIndex`，以及按 UTF-16 计量的 `offset`/`length` 正文分页。`offset` 默认 0，`length` 默认 65536。复制 `nextRead` 可保持相同投影和内容块继续读取，也可保持这些参数并使用 `nextOffset`。结果回报请求长度、实际返回长度、总长度和 `pageEnd`：`complete`、`length` 或 `output_budget`。

`view: "exchange"` 读取工具调用与该调用 ID 再次使用之前的每个匹配结果；从结果出发时定位最近的前序调用。`contentIndex` 可在多调用消息中指定一个调用。缺失的调用或结果会明确标记。`view: "neighbors"` 读取锚点附近的日志条目，`before`、`after` 默认 2，上限 20。这两个关联视图使用 `limit`/`cursor`/`order`，默认从旧到新，并保持快照。续页保持相同的锚点、范围和顺序，可调整 `limit` 和 `projection`。视图参数冲突会指出具体字段及适用的分页参数。邻近视图表达日志位置关系。完整会话日志作为证据来源。

单块匹配的 `contentIndex` 和 `offset` 可与所需的 UTF-16 `length` 一起传给 `history_read`，精确读取指定片段。块读取和搜索共用渲染坐标，条目元数据放在正文切片之外。`spansBlocks: true` 或未指定内容下标的匹配通过条目 ID 读取完整证据。空内容的 assistant 响应作为元数据保留，包含已记录的停止原因和错误。

列表和搜索结果中的工具调用配对元数据按输出预算截取。`omittedToolCalls` 表示该元数据省略的调用数量；通过条目 ID 调用 `history_read` 可读取完整调用详情。

### 图像读取

使用 `history_read({ entryId, view: "image", contentIndex })` 加载 `pi://entry/<id>/content/<index>` 对应的原始图片。该视图接受条目 ID 和内容下标，成功时返回一个规范化 `ImageContent`、有界来源说明，以及来源条目、窗口、尺寸、MIME 类型和编码前后大小信息。

图像读取需要支持图像输入的模型和有效图像字节。pi 的公开图像工具将副本规范化至最多 2000×2000 像素，base64 载荷小于 4.5 MiB。图像无效、来源不可用、模型不支持图像或容量不足时，返回带来源引用的明确文本错误。

符合请求预算的图像会出现在紧接的下一次实际模型请求中，包括发生原生压缩，或同批包含大型普通工具结果和多个图像读取的情况。每个工具调用均保留匹配结果。无法容纳的图像会在该请求中替换为带来源引用的文本错误。若连包含这些错误和必需上下文的最小请求也无法容纳，运行会因容量错误而停止。后续请求可用元数据引用表示已投递的图像。

使用 `openai-responses` 时，请求中的工具图像以 user 内容附在完整工具结果批次之后，并标明来源调用 ID。工具结果保留文字和调用配对，会话日志保留原始图像块。

## 配置与预算

扩展配置均使用 `LEDGER_CONTEXT_` 命名空间。所有覆盖值都必须是正整数，且 `LEDGER_CONTEXT_URGENT_TOKENS` 小于 `LEDGER_CONTEXT_REMINDER_TOKENS`。

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `LEDGER_CONTEXT_REMINDER_TOKENS` | `max(2, floor(min(window × 0.20, 32768)))` | 柔性提醒在有效边界前的提前量；已用 token 触发值为 `B - 提前量` |
| `LEDGER_CONTEXT_URGENT_TOKENS` | `max(1, min(默认柔性提醒提前量 − 1, floor(min(window × 0.10, 16384))))` | 紧急提醒在有效边界前的提前量；已用 token 触发值为 `B - 提前量` |
| `LEDGER_CONTEXT_LEDGER_TOKENS` | `4096` | Agent checkpoint 的估计 token 上限 |
| `LEDGER_CONTEXT_DELTA_TOKENS` | `2048` | 累计 compaction delta 的估计 token 上限 |
| `LEDGER_CONTEXT_TASK_TOKENS` | `max(1, floor(window × 0.05))` | 任务和请求恢复文本的估计 token 上限 |
| `LEDGER_CONTEXT_TAIL_TOKENS` | `max(1, floor(window × 0.05))` | 近期交互显示的估计 token 上限 |
| `LEDGER_CONTEXT_READ_TOKENS` | `2048` | 单次历史查询或读取的总估计输出上限；图像读取还包含来源元数据、说明文字和图像估计 |
| `LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS` | `max(1, floor(min(window × 0.10, 16384)))` | 每次保守请求预算中预留的输出空间 |

每次请求预算都包含系统提示、活动工具定义及提示指南、模型元数据、选中的消息和恢复内容，以及输出预留。完整请求能够容纳时，当前必需的工具调用与结果、刚读出的图像可以超过近期交互上限；可选历史内容仍受分配额度约束。图像读取同时遵守 `LEDGER_CONTEXT_READ_TOKENS` 总量限制。

Checkpoint 和 delta 正文各自最多包含 `65,536` 个 UTF-8 字节；checkpoint 最多接受 `8` 个活动请求引用。历史搜索文本最多包含 `8,192` 个 UTF-8 字节，标识符最多包含 `1,024` 个 UTF-16 代码单元，每页历史查询最多返回 `100` 项。正文读取接受的最大长度为 `65,536` 个 UTF-16 代码单元。这些输入限制与输出预算共同生效。

pi 的上下文用量由提供方报告的用量与后续消息的估算量组成。提供方用量未知时，Ledger Context 根据请求中的有界消息、系统提示、活动工具定义和模型元数据估算用量；完整请求容量另计输出预留。文本和图像估算用于容量决策，其精度取决于模型的 token 计量方式。

## 恢复状态

- Delta 状态为 `generated`、`reused`、`empty`、`stale` 或 `unavailable`。生成失败时保留 checkpoint 和早期匹配 delta，后续工作通过保留消息和来源引用恢复。
- 已保存的 checkpoint 和 delta 正文须完整容纳。容量不足时保留其身份并停止请求或压缩；恢复足够的模型窗口或预算后，可让主 agent 保存更小的 checkpoint。
- 压缩正常取消和无效检查点输入保留上一有效窗口和检查点。
- 持久会话日志写入失败时，当前运行及后续保存和切窗停止。使用新的公开 `SessionManager` 重新打开持久文件以继续持久恢复。
- `fork`、`tree`、`resume`、`reload`、新会话和模型切换都沿选中分支重建状态，每条分支保留自己的账本、窗口记录和待处理提醒来源。
