# pi Ledger Context 扩展

Ledger Context 在 pi 会话日志中保存主 agent 的 checkpoint 和独立的累计 compaction delta，通过公开 ExtensionAPI 和 SDK 为每次压缩保存固定的恢复摘要。

## 运行前提

- 运行基线为 `@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-ai` `>=0.87.1 <0.88.0`，要求 Node.js `>=22.19.0`；开发与验证使用 0.87.1。
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
- `history_read` 读取条目、原始内容块、单张图片、工具调用过程、邻近日志条目或一批条目/图片选择。
- `history_list_items` 按条件浏览条目和 checkpoint 版本，返回有界预览。
- `history_list_windows` 提供窗口导航、过滤统计、用户措辞和 ledger 摘录。
- `get_context_remaining` 返回模型余量、有效边界余量、输出预留及用量来源。

## 检查点与恢复

使用 `checkpoint` 的 `ledger` 提交当前完整工作状态，可选的 `sourceQuotes` 提交从来源消息复制的原句，按恢复优先级排列并区分大小写。匹配将连续空白视为等价分隔符，并忽略引用首尾空白；文字、标点和词间边界保持字面含义。重要事实和约束直接写入 ledger。成功保存后替换后续压缩使用的基线及完整来源列表，省略 `sourceQuotes` 保存空列表；旧版本保留在历史中。回执标明条目、请求位置、大小、持久化范围，以及各原句的 `matched`、`ambiguous` 或 `unmatched` 定位结果。Pi 控制压缩时机。

原句在生成 checkpoint 的请求快照内定位，范围为当前分支的原始用户、助手和普通工具消息，并应用 context edit。每句记录匹配条目总数与按时间保留的前四个候选，包括 ID、编辑来源和首次命中位置。有歧义或未命中的引用随有效 ledger 保存。Agent 判断相关性，扩展提供字面定位信息。

账本保持简短，记录目标和状态、约束和决策、已验证的结果及证据、下一步或等待条件、恢复引用，以及适用的可用技能或“无”。细节通过路径和条目 ID 引用，计划与已完成工作分别标明，敏感信息使用脱敏表示。

Checkpoint 由主 agent 的 checkpoint 工具写入。Delta 生成输入包含只读 checkpoint、上一份匹配的累计 delta，以及 Pi 当前窗口内选中证据的完整文字。新 checkpoint 以其生成请求位置建立新的 delta 基线；旧窗口 checkpoint 与匹配的累计 delta 接续。无 checkpoint 时，首份 delta 从分支起点开始，后续窗口继承上一份 delta 并使用本窗口证据。图片通过来源引用表示。输入超过模型请求容量时，明确记录 unavailable 或 stale 状态。

恢复记录使用 schema version 6。会话内的恢复记录须通过该 schema 与分支来源校验；无效记录会使恢复过程明确报错并停止。

Pi 的 buildSessionProjection() 提供当前窗口有效证据，包含原生保留尾部。Context edit 决定有效内容的排除与替换，对仍保留的较早证据所作的新替换参与下一次 delta 取材。替换文字和图片引用指向编辑记录。Recovery 保存来源定位信息，agent 通过历史工具读取正文。压缩采用 Pi preparation 提供的 firstKeptEntryId。

Delta 生成器可在末尾另起一行输出 `<source-references>[{"entryId":"已提供的ID","quote":"可选来源原句"}]</source-references>`。该块解析为独立 sourceReferences 元数据，与 checkpoint 共用引用匹配规则。每份新 delta 替换完整累计来源列表，省略时保存空列表。ID 在已提供的证据与继承的定位信息中解析，包含替换编辑记录。格式错误共享生成重试次数；未定位的选择器随有效 delta 正文保存。

Context edit 控制后续取材中的来源正文。已有 checkpoint 和 delta 的文字保留当时的记录含义；已总结事实需要更正时，由主 agent 保存修订后的 checkpoint。

`inputCoverage` 是不可变的输入记录。Agent checkpoint 使用 `measurement: "unmeasured"`、`source: "agent-context"`、`snapshotThrough` 和 `recoveryBasis`；后者记录生成它的主请求中投影的 checkpoint/delta ID，没有恢复视图时为 null。Delta 请求使用 `measurement: "measured"` 和 `source: "compaction-delta"`，包含以下字段：

| 字段 | 含义 |
| --- | --- |
| `measurement`、`source`、`snapshotThrough` | 测量可用性、生成路径和请求快照末端，所有输入记录均包含这些字段。 |
| `baseCheckpointEntryId`、`baseDeltaCompactionEntryId` | 实际作为基础输入提供的 checkpoint 和早期生成 delta 的来源 ID，或 null。 |
| `historyScope` | 已测量请求的历史选择区间：从 `afterEntryId` 之后，到包含 `throughEntryId` 为止；下界为 null 表示从分支起点开始。 |
| `representation` | `rendered-text-with-image-references`：提供的文字包含图片引用；像素通过独立图像读取获取。 |
| `fullRanges` | 本次 delta 请求完整提供了渲染正文的条目范围，包含首尾条目。 |
| `projections` | `checkpoint-ledger`、`delta-ledger`、`filtered-entry` 或 `context-edit`，记录来源 ID 和已提供/总 UTF-16 长度；context-edit 记录所用 editEntryId。 |
| `omittedRanges` | historyScope 内没有通过完整正文、投影或排除记录表示的条目范围，包含首尾条目。 |
| `excludedRanges` | 按 maintenance、structural-metadata、context-omitted 或 inactive-context（位于 Pi 当前投影之外）排除的范围。包含实质证据的历史工具结果可参与取材。 |

Delta 的 scope 表示累计目标区间，输入记录的 historyScope 表示本次考虑的新历史区间。Pi 原生保留的证据可能位于该区间之前。旧 delta 是摘要投影，其原始输入记录保留在来源条目中。这些记录描述已提供材料，agent 判断相关性与验证需求。

生成输入显式提供基础 checkpoint 与上一份 delta。原始证据来自当前 Pi 投影，合格消息完整渲染；混有维护调用的 assistant 消息记录为过滤投影。请求容量计入生成指令与输出预留，容量失败保留已保存状态。

回执、列表和恢复视图展示简短 inputRecord 来源信息。通过 history_read 读取 checkpoint 或承载 delta 的 compaction，可查看完整记录与浏览调用；沿早期 delta 来源可追溯继承的证据。生成失败后缺失的历史仍可通过记录的范围及分支历史定位。

恢复摘要在所属 compaction 时生成并保存一次。普通工作、checkpoint、历史读取、来源编辑和配置变化保持该正文固定，下一次 compaction 使用最新成功保存的 checkpoint 与匹配 delta。当前分支校验摘要归属，recoveryBasis 标明保存摘要所代表的 checkpoint 与 delta。原始保留尾部由 Pi 提供。

Delta 使用当前模型和宿主认证生成。暂时性错误和无效输出共享最多三次尝试，并使用可取消的退避等待；认证、请求格式和账户额度错误直接进入恢复流程。每次尝试等待响应或错误，期间可由用户取消。没有新增合格材料或 custom instructions 时，压缩复用匹配 delta 或记录 empty 状态。新 delta 随 pi compaction 条目提交后生效。

恢复视图区分保存的状态与后续变化。后续用户更正和原始执行证据可以修正旧事实；delta 没提及某项时，checkpoint 中的该项仍然保留。`requestHistoryPosition` 和 `compactionSnapshot` 标明请求边界，`eventsAfterDeltaInput` 定位本次压缩快照内、delta 输入或 checkpoint 请求位置之后的事件，供按需调查。这些字段描述来源，agent 决定需要核验什么。工具调用保留匹配结果，完整来源条目保留在会话日志中。

已知条目 ID 时使用 `history_read`。需要定位证据时，浏览窗口和条目，或按已知关键词搜索，再读取返回的 ID。检索范围以支持下一步操作所需的证据为准。

## 提醒与原生边界

Ledger Context 从当前分支最新 agent checkpoint 的请求位置与最近一次已提交 compaction 中较晚的位置之后统计新增工作量；两者均无时从分支起点统计。保留历史和恢复材料位于新窗口的计量起点之前，checkpoint 的来源记录保持原样。工作量统计覆盖普通用户消息、助手工作和普通工具交互。请求容量同时包含 checkpoint、历史工具、容量查询和提醒等维护活动。体积提醒的间隔为当前模型窗口的 10%，向下取整且至少一个 token。每跨过一个新区间排队一条提醒；大型结果跨过多个区间时按最高位置提醒一次。已提醒的位置在所属窗口和 checkpoint 起点内跨重载保留；模型变化时重新计算间隔并保留已提醒进度。

提醒是一次性的 checkpoint 请求，范围由产生时的窗口和 checkpoint 基线确定。每次投递将新触发的工作量与预算原因合并为一条通知。工具批次结束后，通过 pi 原生消息插入机制投递；运行结束后，待处理原因留到下一次正常用户请求，按当时的状态计算。紧急度升级在末尾追加新通知。已投递提醒保持原有正文和位置，原生压缩保留尾部中的提醒同样如此。正文中的范围使稍后抵达的旧窗口提醒能够被识别为已由该次压缩完成。

成功保存 checkpoint 的回执确认：截至该检查点所记录历史位置的提醒请求已经完成。同一个 run 中，后续新增工作仍可触发提醒。已投递的预算级别在所属窗口内跨保存和重载保持去重。提醒在日志中保留 custom 身份，Pi 将其转换为模型输入中的 user 消息；其他扩展强制替换系统提示时，这条投递路径仍然有效。详细计量信息与工作区间的来源条目 ID 保存在 metadata 中。来源选择排除维护提醒记录；请求快照 ID 可以指向提醒记录。

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

历史查询工具共用结构化 `filter`。不同字段按 AND 组合，同一数组内的值按 OR 组合，`excludeKinds` 优先。查询范围限定在当前会话分支。历史读取返回原始日志正文，包含已压缩或从上下文排除的条目；条目正文列出相关 context edit ID，读取编辑记录可查看目标、替换正文或排除标记。替换图片使用编辑记录 ID 下的引用，并支持 `view: "image"`。

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

Checkpoint 结果包含前一个可解析版本的 ID、来源窗口、请求位置和快照内的 active 标记。fitsCurrentLedgerBudget 独立报告当前容量；新 compaction 摘要按限额校验完整 checkpoint 与 delta。compaction_delta 结果定位生成 delta 的原始条目，包含基线、范围和输入记录。复用或过期 delta 引用其原始条目。

`history_list_windows` 接受共用过滤条件、顺序、条数和游标，包含初始窗口及条目数为零的已提交窗口。`entryCount` 和首尾条目 ID 描述原生窗口归属；`matchedEntryCount`、`kindCounts`、`failedToolResults`、`imageCount` 使用与条目列表相同的过滤条件。工具调用按调用数统计，其他种类按条目数统计。最新用户预览引用匹配的输入原文；checkpoint 数量、摘录和最新输入记录的来源信息独立于过滤条件，按原始来源窗口组织。预览截断标记区分完整措辞与摘录。续页保持 filter/order，可调整 `limit`；`returnedCount` 和 `pageEnd` 描述本页状态。默认历史结果遵守 `LEDGER_CONTEXT_READ_TOKENS` 预算。

窗口独立展示 `deltaStatus`、`deltaActive`、承载 delta 的 compaction ID、基础 checkpoint、预览和 `deltaInputRecord`。Checkpoint 数量统计主 agent 保存的版本；新 checkpoint 生效后，窗口已提交的 delta 状态继续作为历史信息保留。

```ts
history_search({ query: "timeout", filter: { kinds: ["tool_result"], toolNames: ["bash"], statuses: ["failed"] }, projection: "text" });
history_list_items({ filter: { kinds: ["checkpoint"] }, limit: 5 });
history_list_items({ filter: { kinds: ["compaction_delta"] }, limit: 5 });
history_read({ entryId: "result-id", view: "exchange" });
```

`get_context_remaining` 提供只读容量快照：`modelRemainingTokens` 表示模型窗口余量，`tokensUntilBoundary` 表示有效边界前的余量；`usageKind` 区分 `pi-context-usage`、`projected-content-estimate` 和不可用状态，不可用的数值为 null。Pi 管理压缩时机。

`history_read` 默认使用 `view: "entry"`，接受 `projection`、可选的原始 `contentIndex`，以及按 UTF-16 计量的 `offset`/`length` 正文分页。`offset` 默认 0，`length` 默认 65536。复制 `nextRead` 可保持相同投影和内容块继续读取，也可保持这些参数并使用 `nextOffset`。结果回报请求长度、实际返回长度、总长度和 `pageEnd`：`complete`、`length` 或 `output_budget`。

`view: "exchange"` 读取工具调用与该调用 ID 再次使用之前的每个匹配结果；从结果出发时定位最近的前序调用。`contentIndex` 可在多调用消息中指定一个调用。缺失的调用或结果会明确标记。`view: "neighbors"` 读取锚点附近的日志条目，`before`、`after` 默认 2，上限 20。这两个关联视图使用 `limit`/`cursor`/`order`，默认从旧到新，并保持快照。续页保持相同的锚点、范围和顺序，可调整 `limit` 和 `projection`。视图参数冲突会指出具体字段及适用的分页参数。邻近视图表达日志位置关系。完整会话日志作为证据来源。

单块匹配的 `contentIndex` 和 `offset` 可与所需的 UTF-16 `length` 一起传给 `history_read`，精确读取指定片段。块读取和搜索共用渲染坐标，条目元数据放在正文切片之外。`spansBlocks: true` 或未指定内容下标的匹配通过条目 ID 读取完整证据。空内容的 assistant 响应作为元数据保留，包含已记录的停止原因和错误。

列表和搜索结果中的工具调用配对元数据按输出预算截取。`omittedToolCalls` 表示该元数据省略的调用数量；通过条目 ID 调用 `history_read` 可读取完整调用详情。

`truncate: false` 对选中的查询或读取取消预算裁剪，显式 length、maxChars 和 limit 仍定义请求范围。未指定文字长度或预览上限时，无裁剪模式返回完整选中文字。`history_read({ view: "many", items: [{ entryId: "a" }, { entryId: "b", offset: 100, length: 200 }], truncate: false })` 按顺序读取最多 100 项。Many 子项支持 entry 与 image，共用一次分支快照并逐项报告错误。默认 many 输出共用一个预算；复制包含快照的 nextRead 继续读取。已返回的工具结果在历史中保持固定。

### 图像读取

使用 `history_read({ entryId, view: "image", contentIndex })` 加载 pi://entry/<id>/content/<index> 对应的图片。扩展校验所选内容块和 base64 载荷，返回来源字节、说明文字与来源元数据。

Pi 在工具结果进入历史前，按自身自动缩放设置与当前模型图像配置处理图片。扩展记录来源元数据，Pi 负责输出尺寸、格式和 provider 编码。历史输出预算计入图片 token 估计。模型输入不支持、选择无效或输出容量不足时，错误明确携带来源。

成功图片以 Pi 处理后的工具结果块进入历史。后续主 agent 请求保持 Pi 投影提供的消息与工具配对。

## 配置与预算

扩展配置均使用 `LEDGER_CONTEXT_` 命名空间。Token 预算值必须是正整数，且 `LEDGER_CONTEXT_URGENT_TOKENS` 小于 `LEDGER_CONTEXT_REMINDER_TOKENS`。

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `LEDGER_CONTEXT_REMINDER_TOKENS` | `max(2, floor(min(window × 0.20, 32768)))` | 柔性提醒在有效边界前的提前量；已用 token 触发值为 `B - 提前量` |
| `LEDGER_CONTEXT_URGENT_TOKENS` | `max(1, min(默认柔性提醒提前量 − 1, floor(min(window × 0.10, 16384))))` | 紧急提醒在有效边界前的提前量；已用 token 触发值为 `B - 提前量` |
| `LEDGER_CONTEXT_LEDGER_TOKENS` | `4096` | Agent checkpoint 的估计 token 上限 |
| `LEDGER_CONTEXT_DELTA_TOKENS` | `2048` | 累计 compaction delta 的估计 token 上限 |
| `LEDGER_CONTEXT_READ_TOKENS` | `2048` | 单次历史查询/读取的默认总输出估计上限，包含图片估计；truncate: false 显式取消该次调用的裁剪 |
| `LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS` | `max(1, floor(min(window × 0.10, 16384)))` | 容量报告、提醒及压缩恢复预算使用的预留空间 |

Pi 管理主请求容量、图片处理、provider 编码和原始尾部选择。扩展限额用于 checkpoint/delta 正文、新恢复摘要和默认历史工具输出。显式 truncate: false 完整返回请求范围，Pi/provider 的容量限制仍适用。

Checkpoint 和 delta 正文各允许 65,536 个 UTF-8 字节、最多 8 个来源选择器；原句上限为 512 个 UTF-16 单元，每个选择器保留最多 4 个候选。搜索文本允许 8,192 个 UTF-8 字节，标识符允许 1,024 个 UTF-16 单元，分页和 many 批次最多 100 项。显式正文偏移和长度采用安全整数。默认正文请求 65,536 个 UTF-16 单元，未指定长度的无裁剪读取返回全部剩余文字。

pi 的上下文用量由提供方报告的用量与后续消息的估算量组成。提供方用量未知时，Ledger Context 估算有效投影中的对话与恢复材料，并将系统提示、活动工具定义和模型元数据各计一次。这些估算用于容量报告、提醒及压缩恢复预算，精度取决于模型的 token 计量方式。

## 恢复状态

- Delta 状态为 `generated`、`reused`、`empty`、`stale` 或 `unavailable`。生成失败时保留 checkpoint 和早期匹配 delta，后续工作通过保留消息和来源引用恢复。
- 新恢复摘要在配置限额内包含完整 checkpoint 与 delta。容量错误保留已保存记录和既有恢复正文。
- 压缩正常取消和无效检查点输入保留上一有效窗口和检查点。
- Pi 先准备压缩再调用扩展。可总结内容不足时返回 `Nothing to compact`，带自定义指令的手动 `/compact` 同样遵守此规则；checkpoint、delta 和窗口保持原样，checkpoint 保存仍可独立执行。
- 持久会话日志写入失败时，当前运行及后续保存和切窗停止。使用新的公开 `SessionManager` 重新打开持久文件以继续持久恢复。
- `fork`、`tree`、`resume`、`reload`、新会话和模型切换都沿选中分支重建状态，每条分支保留自己的账本、窗口记录和待处理提醒来源。
