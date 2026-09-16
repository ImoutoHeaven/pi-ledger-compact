# pi Ledger Context Extension

Ledger Context keeps a bounded working ledger in the pi session log and carries it into a deterministic recovery bootstrap at native context compaction. The extension uses pi's public `ExtensionAPI` and SDK.

## Requirements

- Runtime baseline: `@earendil-works/pi-coding-agent` 0.85.1 with Node.js `>=22.19.0`.
- Keep pi native automatic compaction enabled for automatic window changes. Pi owns the compaction threshold, session log, steering and follow-up queues, overflow retry, and compaction lifecycle.
- Configure one compaction content extension per session. Ledger Context supplies the compaction summary and recovery bootstrap for each window.
- All six model tools and manual `/compact` remain available when automatic compaction is disabled.

## Installation

From the checkout root, install this package as a local pi package. The manifest loads `src/ledger-context.ts`.

```bash
pi install -l .
```

The package registers these model tools:

- `checkpoint` saves a complete active ledger and returns its persistence scope and handoff state.
- `history_search` finds literal text in selected history parts and returns source references and match coordinates.
- `history_read` reads an entry, an original content block, one image, a tool exchange, or neighboring log entries.
- `history_list_items` browses filtered entries and checkpoint versions with bounded previews.
- `history_list_windows` provides window navigation, filtered counts, user wording, and ledger excerpts.
- `get_context_remaining` reports model headroom, effective-boundary headroom, output reserve, and usage provenance.

## Checkpoints and recovery

Call `checkpoint` with the complete active ledger and optional current-branch user request entry IDs. A successful receipt contains the checkpoint entry ID, source window ID, request history position, estimated ledger size, persistence scope, and `awaiting-native-compaction-threshold` handoff state.

Keep the ledger brief: goal and status, constraints and decisions, verified results and evidence, next step or wait condition, recovery references, and useful available skills or “none.” Use paths and entry IDs for detail, distinguish plans from completed work, and redact secrets.

Checkpoint metadata uses schema version 2. Its `inputCoverage` records the input snapshot and inherited coverage gaps separately from the ledger:

| Field | Meaning |
| --- | --- |
| `source`, `baseCheckpointEntryId`, `snapshotThrough` | Generation path, preceding checkpoint used as the coverage basis, and request snapshot tip. |
| `representation` | `rendered-text-with-image-references`: coverage describes rendered text; image pixels require a separate image read. |
| `fullRanges` | Inclusive ranges whose complete rendered entry text was supplied to this ledger request. |
| `partialEntries` | Supplied prefixes with `providedChars` and `totalChars` in UTF-16 units; zero supplied characters indicates a reference-only entry. |
| `omittedRanges` | Inclusive ranges omitted from the new history since the preceding checkpoint request. |
| `outstandingGaps` | Inherited and current gaps, with reason `omitted`, `partial`, or `unknown`; each inclusive range includes its entry count. |

Automatic refresh measures the final task anchors and selected history together. A complete text entry supplied through either path resolves its text-coverage gap. Saving another ledger carries remaining gaps forward. Agent-authored `checkpoint` calls mark the new request interval as `unknown` and preserve preceding gaps. Coverage records supplied input; understanding, retained meaning, and execution verification are separate judgments supported by evidence.

Checkpoint receipts, listings, window summaries, and recovery bootstraps show compact coverage counts. Read a checkpoint with `history_read` and follow `nextRead` for its complete manifest and gap recovery calls. Those calls convert inclusive coverage ranges to the history filter's exclusive bounds. Inspect gaps relevant to the next decision; the full session log remains available for evidence recovery.

The bootstrap identifies the previous checkpoint, latest user request, and latest completed assistant answer. `requestHistoryPosition` records the log position at the start of the model request that produced the checkpoint; `pendingHistoryRange` identifies subsequent events. Use these positions to locate evidence, then use retained text or `history_read` to establish what the ledger reflects and verify execution facts before continuing actions with side effects.

Saving a checkpoint lets the current run continue. Pi controls compaction timing. Every automatic compaction and manual `/compact [instructions]` attempts to refresh the ledger using the current model, host authentication, previous usable ledger, latest task, and bounded subsequent history. Transient network or service errors, rate limits, and empty, truncated, oversized, or invalid output share a maximum of three total generation attempts with cancellable backoff. Authentication, invalid-request, and account-limit errors go directly to recovery. Each attempt waits for the response or an error, subject to user cancellation. Valid output is saved once as a checkpoint and included in recovery. Failed generation restores the previous usable checkpoint with an explicit stale-ledger warning and recovery references. When that checkpoint is unavailable or exceeds the current ledger budget, the bootstrap explicitly directs recovery from session history. User cancellation cancels compaction; a checkpoint write failure stops recovery until the persisted session is reopened.

The bootstrap carries the latest ledger, current task and latest user wording, window metadata, bounded recent interaction, execution state, and direct history references. Assistant tool calls stay paired with every matching result. Persistent sessions keep complete entries in the pi session log as the durable evidence source; in-memory sessions keep them for the current process.

Read known entry IDs with `history_read`. Locate evidence by browsing windows and entries or by searching a known phrase, then read the returned IDs. Retrieve the evidence needed for the next action.

## Reminders and native boundaries

Ledger Context measures new work from the active checkpoint request position, or from the current window start when no checkpoint exists. The volume counter covers ordinary user messages, assistant work, and ordinary tool interactions. Request capacity also includes checkpoint, history-tool, context-budget, and reminder maintenance. The volume reminder interval is 10% of the current model's context window, rounded down to at least one token. Each new interval queues one notice; a large result crossing several intervals produces one notice for the highest crossed mark. Delivered marks survive reload, and a model change recalculates the interval while preserving already-notified progress. A successful checkpoint resets the volume origin. `LEDGER_CONTEXT_TAIL_TOKENS` controls retained history independently.

Reminders are triggered by accumulated work volume or budget pressure. After a tool batch, they use pi's native steering; when a run has already ended, pending reminders wait for the next normal user request. Pending reasons are combined into one notice and deduplicated separately. Ordinary work continues while reminders are delivered.

Known native settings use the effective boundary `B = min(W - O, W - R)`, where `W` is the model window, `O` is the extension output reserve, and `R` is pi's native compaction reserve. Disabled or unknown native settings use `B = W - O` with window protection. The reminder settings are lead times before B. For `W=500000`, `O=16384`, and `R=27200`, `B=472800`; the default soft and urgent used-token triggers are `440032` (`B - 32768`) and `456416` (`B - 16384`), with lead times of `32768` and `16384` tokens.

The package reads native settings through the public `SettingsManager`, using the current working directory, agent directory, and project trust state. An SDK host can supply its actual settings through `settingsReader`. Here, `settingsManager` is the host's existing instance; include `ledgerExtension` in the `extensionFactories` constructor option of the host's resource loader:

```ts
import { createLedgerContext } from "./src/ledger-context.ts";

const ledgerExtension = createLedgerContext({
  settingsReader: () => ({
    source: "host SettingsManager",
    compaction: settingsManager.getCompactionSettings(),
  }),
});
```

Settings failures mark the native boundary as unknown and use window protection. Model, working-directory, and configuration changes recalculate the boundary.

## History recovery

The history query tools share a structured `filter`. Fields combine with AND, array values with OR, and `excludeKinds` takes precedence. Queries stay on the current session branch.

| Filter | Meaning |
| --- | --- |
| `kinds`, `excludeKinds` | Select or exclude `user_input`, `assistant_text`, `tool_call`, `tool_result`, `checkpoint`, and `metadata` parts. Omission includes all kinds. |
| `toolNames` | Exact tool names; selects matching invocations and results. |
| `statuses` | Logged entry status: `received`, `requested`, `completed`, `failed`, `saved`, `committed`, or `metadata`. |
| `windowIds` | Committed window IDs or the initial window ID. |
| `afterEntryId`, `beforeEntryId` | Exclusive positions inside the branch snapshot. |
| `hasImage` | Select entries by presence of original image blocks. |
| `includeMaintenance` | Include checkpoint/history/budget tool traffic; defaults to false. Saved checkpoint records remain selectable independently. |

`history_list_items` and `history_search` return one item per source entry, with selected `kinds`, execution state, and source IDs. Search requires a nonempty literal `query` and ignores case unless `caseSensitive: true`. Matching is independent of returned content. `projection` is `all` by default: `all` returns previews and image references, `text` returns text from selected parts including mixed image entries, `images` returns image references, and `references` returns entry metadata. `maxChars` sets the per-entry preview ceiling, defaulting to 256 UTF-16 code units. Search reports the original matching `contentIndex` and offsets in the selected rendered text. Image matching uses textual metadata.

Item lists and searches return `items`, `totalMatches`, `returnedCount`, `snapshotThrough`, and `nextCursor`. `order` is `newest` by default and also accepts `oldest`. Version 4 cursors bind the branch snapshot, tool, filters, ordering, and match options. Continue with the same selection arguments; `limit`, `maxChars`, and `projection` may change between pages. Later activity leaves that snapshot stable. `limit` and `maxChars` are ceilings within the output budget. `pageEnd` reports `complete`, `limit`, or `output_budget`; a preview's truncation marker directs a full entry read. Invalid cursors explain continuation and restarting with the current query.

Checkpoint items include the prior parsed checkpoint ID, source window, request history position, and snapshot-relative `active` flag. `fitsCurrentLedgerBudget` checks the checkpoint schema and current ledger budget; full bootstrap capacity is checked at compaction. Older checkpoints remain discoverable when the ledger budget shrinks.

`history_list_windows` accepts the shared filter, ordering, limit, and cursor. It includes initial and committed windows even when empty. `entryCount` and first/last entry IDs describe native window attribution; `matchedEntryCount`, `kindCounts`, `failedToolResults`, and `imageCount` use the same filter as item listing. Tool-call counts count invocations; other kinds count entries. Latest user previews quote matching inputs. Checkpoint counts, excerpts, and latest coverage describe snapshots grouped by original source window independently of the filter. Preview truncation flags distinguish complete wording from excerpts. Continue with the same filter/order and an adjustable `limit`; `returnedCount` and `pageEnd` describe the page. Successful history results obey `LEDGER_CONTEXT_READ_TOKENS`.

```ts
history_search({ query: "timeout", filter: { kinds: ["tool_result"], toolNames: ["bash"], statuses: ["failed"] }, projection: "text" });
history_list_items({ filter: { kinds: ["checkpoint"] }, limit: 5 });
history_read({ entryId: "result-id", view: "exchange" });
```

`get_context_remaining` is a read-only capacity snapshot. `modelRemainingTokens` measures model headroom; `tokensUntilBoundary` measures headroom before the effective boundary. `usageKind` distinguishes pi-reported usage, bounded estimates, and unavailable data; unavailable numeric values are null. Pi controls compaction timing.

`history_read` defaults to `view: "entry"` and accepts `projection`, an optional original `contentIndex`, and UTF-16 `offset`/`length` pagination. `offset` defaults to 0 and `length` to 65536. Copy `nextRead` to continue with the same projection and block, or use `nextOffset` with those parameters. Results report requested/returned lengths, total length, and `pageEnd`: `complete`, `length`, or `output_budget`.

`view: "exchange"` follows a tool call and every matching result up to reuse of that call ID; a result anchor selects its nearest preceding invocation. `contentIndex` can select one invocation in a multi-call message. Missing calls/results are reported explicitly. `view: "neighbors"` reads chronological log entries around an anchor, with `before` and `after` defaulting to 2 and bounded at 20. These related views use `limit`/`cursor`/`order`, default to oldest-first order, and preserve a snapshot. Keep the same anchor, range, and order when continuing; `limit` and `projection` may change. View conflicts name the offending fields and the appropriate paging controls. Neighborhoods express log proximity. The session log remains the evidence source.

Read a single-block search match with its `contentIndex` and `offset`, plus the desired UTF-16 `length`. Block-selected reads use the same rendered block coordinates as search; entry metadata stays outside the sliced text. Matches with `spansBlocks: true` or without a content index use the entry ID for complete evidence. Empty assistant responses remain discoverable as metadata, including recorded stop reasons and errors.

Tool-call pairing metadata in listings and search results fits the output budget. `omittedToolCalls` reports calls left out of that metadata; use the entry ID with `history_read` to recover the complete call details.

### Image reads

Use `history_read({ entryId, view: "image", contentIndex })` to load the original image block identified by `pi://entry/<id>/content/<index>`. This view accepts the entry ID and content index. Each successful call returns one normalized `ImageContent` block, a bounded source note, and provenance with the source entry, window, dimensions, MIME types, and encoded and decoded sizes.

Image reads require an image-capable model and valid image bytes. Pi's public image utilities normalize a copy to at most 2000 by 2000 pixels and less than 4.5 MiB of base64 payload. Invalid, unavailable, unsupported, and capacity-limited selections return an explicit text error with the source reference.

Images that fit the request budget appear in the next actual provider request, including across native compaction or a batch containing large ordinary results and multiple image reads. Every tool call stays paired with its matching results. Images that cannot fit are replaced in that request by text errors with source references. If even the minimum request containing those errors and mandatory context cannot fit, the run stops with a capacity error. Later requests may represent already-delivered images with metadata references.

For `openai-responses`, outgoing tool images are attached as user content after the complete tool-result batch, labeled with their source call IDs. Tool results retain their text and pairing; the session log retains the original image blocks.

## Configuration and budgets

All seven extension settings use the `LEDGER_CONTEXT_` namespace. Every configured value is a positive integer. `LEDGER_CONTEXT_URGENT_TOKENS` is smaller than `LEDGER_CONTEXT_REMINDER_TOKENS`.

| Setting | Default | Purpose |
| --- | --- | --- |
| `LEDGER_CONTEXT_REMINDER_TOKENS` | `max(2, floor(min(window × 0.20, 32768)))` | Soft reminder lead time before the effective boundary; the used-token trigger is `B - lead time` |
| `LEDGER_CONTEXT_URGENT_TOKENS` | `max(1, min(default soft lead time − 1, floor(min(window × 0.10, 16384))))` | Urgent reminder lead time before the effective boundary; the used-token trigger is `B - lead time` |
| `LEDGER_CONTEXT_LEDGER_TOKENS` | `4096` | Estimated token limit for a saved ledger |
| `LEDGER_CONTEXT_TASK_TOKENS` | `max(1, floor(window × 0.05))` | Estimated token limit for task and request recovery text |
| `LEDGER_CONTEXT_TAIL_TOKENS` | `max(1, floor(window × 0.05))` | Estimated token limit for recent interaction display |
| `LEDGER_CONTEXT_READ_TOKENS` | `2048` | Total estimated output for one history query or read; image reads include source metadata, the note, and the image estimate |
| `LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS` | `max(1, floor(min(window × 0.10, 16384)))` | Output space reserved in each conservative request budget |

Each request budget includes the system prompt, active tool schemas and prompt guidelines, model metadata, selected messages and recovery content, and output reserve. Mandatory active tool protocol and fresh images may exceed the recent-tail limit when the full request fits; optional history stays within its allocation. Image reads also obey the total `LEDGER_CONTEXT_READ_TOKENS` limit.

Ledger input has a `65,536` UTF-8 byte limit and accepts at most `8` active request references. History search text allows up to `8,192` UTF-8 bytes, identifiers up to `1,024` UTF-16 code units, and history pages up to `100` results. Text reads accept a maximum length of `65,536` UTF-16 code units. These input limits apply alongside the output budgets.

Pi context usage combines the provider's reported usage with estimates for subsequent messages. When provider usage is unknown, Ledger Context estimates the bounded messages, system prompt, active tools, and model metadata sent in the request. Full request capacity adds output reserve separately. Text and image estimates guide capacity decisions; their accuracy depends on the model's token accounting.

## Recovery states

- Every compaction attempts a ledger refresh; failed refreshes explicitly identify either the restored checkpoint or history-based recovery.
- Normal compaction cancellation and invalid checkpoint input preserve the previous valid window and checkpoint.
- A persistent session log failure stops the current run and future saves or compactions. Reopen the persisted file with a fresh public `SessionManager` to resume durable recovery.
- Fork, tree, resume, reload, new session, and model changes rebuild state from the selected branch. Each branch keeps its own ledger, window records, and pending reminder provenance.
