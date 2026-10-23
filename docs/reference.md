# pi-ledger-compact Reference

Authoritative schemas and runtime logic live in
[`src/ledger-context.ts`](../src/ledger-context.ts).

## 1. Model Tools

All six tools register with `executionMode: "sequential"` and
`exposure: "model-only"`. Endpoints with strict function calling can pass `null`
for omitted optional parameters; `null` is rejected for required fields and
array items.

### `checkpoint`

Saves the active recovery baseline on the current branch:

- **`ledger`**: Complete working state string, up to `65536` UTF-8 bytes and
  `LEDGER_CONTEXT_LEDGER_TOKENS` (default `4096`). An empty or whitespace-only
  string counts as omitted when another mode is supplied.
- **`edits`**: Non-empty array of `{ oldText, newText }` replacements applied to
  the saved state (`<checkpoint ledger>` followed by
  `\n\n## Folded compaction changes\n<delta ledger>` when a delta exists). Each
  `oldText` must match once and ranges must not overlap. When a checkpoint holds
  more than one `## Folded compaction changes` section, the receipt requests a
  complete `ledger` on the next save.
- **`sourceQuotes`**: Up to `8` case-sensitive literal phrases (`1–512` chars)
  matched against non-maintenance branch messages through the request snapshot.
  Whitespace runs match any whitespace run. Omitting `sourceQuotes` clears the
  list on `ledger` saves and keeps up to `8` saved checkpoint+delta references
  on `edits` saves. Passing non-empty `sourceQuotes` alone keeps the saved
  state (including any folded delta) as the ledger and replaces its quote list. Unmatched or ambiguous quotes
  are reported (`matched`, `ambiguous`, `unmatched`, up to `4` matches per quote)
  without failing the save.
- **`compact`**: `"continue"` or `"stop"` (requires `ledger` or state-changing
  `edits`).
  - `"continue"` commits a boundary compaction at `turn_end` right after the
    tool batch and continues the run.
  - `"stop"` commits a boundary compaction at `agent_before_settle` after the
    final reply.
  - The checkpoint covers everything before its call, so no delta is generated
    for that cut. When the `checkpoint` call is the only tool call in its
    assistant message, the call and its receipt leave with the earlier history:
    the new window holds the recovery summary (which says the checkpoint asked
    for it) and the entries after the receipt, such as the final reply in
    `"stop"` mode, so the ledger appears once. When other tool calls share the
    message, the branch is kept from that message on, with their results.
  - Entries that other extensions propose at the same boundary join the new
    window.
  - If removable tokens before the cut fit within Pi's `keepRecentTokens`, the
    receipt reports `Compaction skipped: Nothing to compact (session too small).`
    A later `checkpoint` save in the same run without `compact` cancels an
    earlier pending request. When a scheduled compaction is skipped at the
    boundary (aborted run, model error, earlier handler stop, dropped boundary
    draft, newer compaction, context edit targeting covered history, or summary
    + kept tail above the available budget), the extension appends a
    `ledger-context/compaction-note` message explaining why.

### `history_search` and `history_list_items`

Both tools inspect the current branch snapshot and share:

- **`filter`** (AND across fields, OR within arrays; `excludeKinds` overrides
  `kinds`):
  - `kinds` / `excludeKinds`: `"user_input"`, `"assistant_text"`, `"tool_call"`,
    `"tool_result"`, `"checkpoint"`, `"compaction_delta"`, `"metadata"`.
  - `toolNames`: `1–32` exact tool names (matches calls and results).
  - `statuses`: `"received"`, `"requested"`, `"completed"`, `"failed"`,
    `"saved"`, `"committed"`, `"metadata"`.
  - `windowIds`: `1–32` window IDs from `history_list_windows`.
  - `afterEntryId`, `beforeEntryId`: exclusive branch entry bounds.
  - `hasImage`: boolean filter on original image blocks.
  - `includeMaintenance`: include `checkpoint`, history-tool, and
    `get_context_remaining` traffic (default `false`; `checkpoint` and
    `compaction_delta` kinds remain selectable directly).
- **`projection`**: `"all"` (default, text previews and image references),
  `"text"`, `"images"`, or `"references"`.
- **Paging and budget**: `limit` (`1–100`, default `20`), `maxChars` (preview
  cap per entry, default `256` UTF-16 units), `order` (`"newest"` default, or
  `"oldest"`), `cursor` (`nextCursor` from the previous page; repeat the same
  query, filter, order, and `caseSensitive`), and `truncate` (`false` bypasses
  `LEDGER_CONTEXT_READ_TOKENS` while keeping explicit `limit` and `maxChars`).
- **Search fields** (`history_search` only): Either `query` or `queries`
  (`1–32` literals, up to `8192` UTF-8 bytes total), plus `caseSensitive`
  (default `false`). Hits include `matchedQueryIndexes`, `matchOffset`, and
  `match` with UTF-16 `offset` and optional `contentIndex` / `spansBlocks`.

### `history_list_windows`

Lists the initial window and committed compaction windows on the current branch
with `filter`, `order`, `limit`, `cursor`, and `truncate`. Each window entry
reports native `entryCount`, filtered `matchedEntryCount`, `kindCounts`,
`failedToolResults`, `imageCount`, latest user message preview, checkpoint
counts/excerpts, and `deltaStatus` (`generated`, `reused`, `empty`, `stale`, or
`unavailable`).

### `history_read`

Reads original log entries, including compacted or context-omitted content.
Read the associated `context_edit` entry to inspect a replacement or omission:

- **`view: "entry"`** (default): Reads `entryId` (or one block via
  `contentIndex`) with UTF-16 `offset` (default `0`) and `length` (default
  `65536`). Continue with `nextRead` or `nextOffset`.
- **`view: "image"`**: Requires `entryId` and `contentIndex`; returns the
  validated image block and provenance for `pi://entry/<id>/content/<index>`.
- **`view: "exchange"`**: Reads a tool call and its matching results (oldest
  first; `contentIndex` selects one call in a multi-call message). Paged with
  `limit`, `cursor`, and `order`.
- **`view: "neighbors"`**: Reads entries around `entryId` (`before` and `after`,
  `0–20`, default `2`, oldest first).
- **`view: "many"`**: Reads `1–100` `items` (`entry` or `image` views) in order
  on a shared snapshot (`snapshotThrough`), continuing via `nextRead`.

`truncate: false` bypasses the read budget while respecting explicit ranges;
an entry read without `length` then returns all remaining text.

### `get_context_remaining`

Reports capacity in text and tool `details`: `contextWindowTokens`, `usedTokens`,
`modelRemainingTokens`, `effectiveBoundaryTokens`, `tokensUntilBoundary`, and
`outputReserveTokens` (capacity values are `null` when unavailable).
`usageKind` is `"pi-context-usage"`, `"projected-content-estimate"`, or
`"unavailable"`; `nativeCompactionMode` is `"native"`, `"disabled"`, or
`"unknown"`. `newWorkTokens` estimates work since the latest checkpoint or
compaction.

## 2. Compaction Deltas and Recovery State

When Pi fires `session_before_compact` (automatic threshold, overflow, or manual
`/compact`), the extension:

1. Hydrates the branch's latest valid checkpoint (`ledger-context/checkpoint`,
   schema version `6`) and cumulative compaction delta (`details.kind === "ledger-context"`).
2. Calls `ctx.modelRegistry.streamSimple()` using the active physical model (or
   virtual selection before the first physical response) to summarize new
   eligible branch evidence within `LEDGER_CONTEXT_DELTA_TOKENS` (default `2048`)
   and `65536` UTF-8 bytes. These limits validate saved text; Pi's stream
   options govern model generation.
3. If input exceeds model request capacity, retries packing by leaving Pi's
   verbatim `firstKeptEntryId` tail for the next delta when safe, then truncating
   tool results to `2000` characters with `pi://entry/<id>` references.
4. Retries transient provider/network errors and malformed outputs up to `3`
   attempts (`500ms`, `1000ms` backoff). Non-retryable auth, quota, or
   invalid-request errors fail immediately. Attempt usage is summed into the
   compaction entry's `usage`, and failed attempts are recorded in
   `details.generationFailures` with credentials redacted.
5. If delta generation fails or overflows capacity, records `status: "stale"`
   (when a prior delta exists) or `"unavailable"` (`"generation-failed"`,
   `"input-capacity"`, or `"no-model"`), preserving the saved checkpoint and
   earlier delta. If the recovery bootstrap itself exceeds the available context
   budget, the compaction is cancelled so existing history stays intact.

## 3. Checkpoint Reminders, Usage Notices, and Boundaries

With model window `W`, extension output reserve `O`, and Pi native
`compaction.reserveTokens` `R`:

- **Effective boundary**: `B = max(0, min(W - O, W - R))` when native compaction
  is enabled and readable; otherwise `B = max(0, W - O)`.
- **Work interval**: Let `S = max(B - softLead, floor(B / 2))`.
  The interval is `max(1, floor(S / p))`: `p = 3` for `S <= 150000`,
  `4` for `150000 < S <= 400000`, and `5` above that.
- **Schedule**: Counted from the latest checkpoint request position or committed
  compaction. The first reminder fires after `1` interval of new work (or `0.5`
  interval once used tokens reach `B - softLead`). An unanswered reminder
  repeats once after `+0.25` interval, and once more upon reaching
  `B - urgentLead`. At `turn_end`, reminders queue via `deliverAs: "steer"`; at
  `agent_before_settle`, a repeated or urgent reminder continues the run for one
  turn. Each reminder also states the context use: used tokens against `W` and
  the tokens left before `B`.
- **Usage notices**: After a tool batch with no reminder due or queued, and no
  native compaction due before the next request, a one-line
  `ledger-context/usage` notice reports the same context use, plus new work
  since the latest checkpoint or compaction, once the used tokens reach a step
  of `LEDGER_CONTEXT_USAGE_NOTICE_PERCENT` of `W` that the current window has
  not shown yet. Usage notices, reminders, and `get_context_remaining` results all
  count as shown; a jump over several steps gives one notice, and a new window
  starts over. Notices queue via `deliverAs: "steer"`, never continue a run,
  and stay out of new work, deltas, and `sourceQuotes`, as reminders do.

## 4. Environment Variables

`LEDGER_CONTEXT_USAGE_NOTICE_PERCENT` is an integer from `0` to `100`; every
other `LEDGER_CONTEXT_*` variable must be a positive safe integer
(`LEDGER_CONTEXT_URGENT_TOKENS < LEDGER_CONTEXT_REMINDER_TOKENS`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `LEDGER_CONTEXT_LEDGER_TOKENS` | `4096` | Max estimated tokens for a saved checkpoint ledger |
| `LEDGER_CONTEXT_DELTA_TOKENS` | `2048` | Max estimated tokens for a generated compaction delta |
| `LEDGER_CONTEXT_READ_TOKENS` | `2048` | Default token budget per history query/read (`truncate: false` bypasses) |
| `LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS` | `max(1, floor(min(W * 0.10, 16384)))` | Context headroom `O` reserved for boundary calculation, reminders, and recovery summaries |
| `LEDGER_CONTEXT_REMINDER_TOKENS` | `max(2, floor(min(W * 0.20, 32768)))` | Soft reminder lead time before `B` |
| `LEDGER_CONTEXT_URGENT_TOKENS` | `max(1, min(softDefault - 1, floor(min(W * 0.10, 16384))))` | Urgent reminder lead time before `B` |
| `LEDGER_CONTEXT_USAGE_NOTICE_PERCENT` | `5` | Step of usage notices in percent of `W`; `0` turns them off |

## 5. SDK Host Integration

SDK hosts pass their existing `settingsManager` and complete effective
`mainStreamOptions` snapshot through `createLedgerContext`. Add the returned
factory to the resource loader's `extensionFactories`:

```ts
import { createLedgerContext } from "./src/ledger-context.ts";

const extension = createLedgerContext({
  settingsReader: (ctx) => ({
    source: "host-settings",
    compaction: settingsManager.getCompactionSettings(ctx.model ?? undefined),
  }),
  requestOptionsReader: (_ctx) => mainStreamOptions,
});
```
