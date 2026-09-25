# pi Ledger Context Extension

Ledger Context preserves the main agent's checkpoints and separate cumulative compaction deltas in the pi session log. Each compaction saves a fixed recovery summary through pi's public ExtensionAPI and SDK.

## Requirements

- Runtime baseline: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` `>=0.87.1 <0.88.0` with Node.js `>=22.19.0`; development and validation use 0.87.1.
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
- `history_read` reads an entry, an original content block, one image, a tool exchange, neighboring log entries, or a batch of entry/image selections.
- `history_list_items` browses filtered entries and checkpoint versions with bounded previews.
- `history_list_windows` provides window navigation, filtered counts, user wording, and ledger excerpts.
- `get_context_remaining` reports model headroom, effective-boundary headroom, output reserve, and usage provenance.

## Checkpoints and recovery

Call `checkpoint` with the complete current working state in `ledger` and optional `sourceQuotes`: case-sensitive phrases copied from source messages, ordered by recovery priority. Matching treats whitespace runs as equivalent and ignores a quote's leading and trailing whitespace; letters, punctuation and word boundaries retain their literal meaning. Essential facts and constraints belong in the ledger. A successful save replaces the baseline for subsequent compaction and its entire source list; omitting `sourceQuotes` saves an empty list. Earlier versions remain in history. The receipt reports the saved entry, request position, size, persistence scope, and each quote's `matched`, `ambiguous`, or `unmatched` result. Pi controls compaction timing.

Quotes resolve at save time against original user, assistant and ordinary tool messages on the current branch through the generating request snapshot, with context edits applied. Each quote records its total matching entry count and the first four candidates in chronological order, including IDs, edit provenance and first match offsets. Ambiguous and unmatched quotes accompany a successful ledger save. The agent determines relevance; the extension supplies literal locators.

Keep the ledger brief: goal and status, constraints and decisions, verified results and evidence, next step or wait condition, recovery references, and useful available skills or “none.” Use paths and entry IDs for detail, distinguish plans from completed work, and redact secrets.

Only the main agent's `checkpoint` tool writes checkpoints. Delta generation receives the checkpoint as read-only background, the previous matching cumulative delta, and complete selected text from Pi's current window. A new checkpoint starts a fresh delta baseline at its generating request position. An older checkpoint stays paired with its cumulative delta. Without a checkpoint, the first delta starts at the branch beginning; later windows inherit the preceding delta and use the current window's evidence. Images are represented by source references. Input exceeding the model request capacity produces an explicit unavailable/stale result.

Recovery records use schema version 6. Each session's recovery records must satisfy this schema and its branch provenance checks. Invalid records stop resume with an explicit error.

Pi's `buildSessionProjection()` supplies effective current-window evidence, including its native retained tail. Context edits control effective omission and replacement; new replacements of retained earlier evidence qualify for the next delta. Replacement text and image references cite their edit records. Recovery stores source locators, and the agent reads their text through history tools. The extension uses Pi's prepared `firstKeptEntryId` for compaction.

The delta generator can end its text with `<source-references>[{"entryId":"supplied-id","quote":"optional source phrase"}]</source-references>` on a new line. The block becomes separate `sourceReferences` metadata. Quotes use the checkpoint matcher. Each generated delta replaces its cumulative source list; omission saves an empty list. IDs resolve among supplied evidence and inherited locators, including replacement-edit IDs. Invalid syntax shares the generation retry policy; unresolved selectors accompany valid delta text.

Context edits govern subsequent selection of source text. Existing checkpoint and delta prose keeps its recorded meaning; the main agent can save a revised checkpoint when previously summarized facts need correction.

Each `inputCoverage` is an immutable input record. Agent checkpoints use `measurement: "unmeasured"`, `source: "agent-context"`, `snapshotThrough`, and `recoveryBasis`: the checkpoint/delta IDs projected for the generating main-agent request, or null when no recovery view was supplied. Delta requests use `measurement: "measured"` and `source: "compaction-delta"` with these fields:

| Field | Meaning |
| --- | --- |
| `measurement`, `source`, `snapshotThrough` | Measurement availability, generation path, and request snapshot tip. All input records contain these fields. |
| `baseCheckpointEntryId`, `baseDeltaCompactionEntryId` | Checkpoint and earlier generated delta actually supplied as bases, or null. |
| `historyScope` | Measured requests: the historical selection interval, after `afterEntryId` exclusively through `throughEntryId` inclusively. A null lower bound starts at the branch beginning. |
| `representation` | `rendered-text-with-image-references`: supplied text includes image references; pixels require a separate image read. |
| `fullRanges` | Inclusive ranges whose complete rendered entry text was supplied to this delta request. |
| `projections` | `checkpoint-ledger`, `delta-ledger`, `filtered-entry`, or `context-edit`, with source IDs and supplied/total UTF-16 lengths. `context-edit` records the applied `editEntryId`. |
| `omittedRanges` | Inclusive ranges within `historyScope` supplied through neither direct text nor a recorded projection/exclusion. |
| `excludedRanges` | Inclusive ranges excluded as `maintenance`, `structural-metadata`, `context-omitted`, or `inactive-context` outside Pi's current projection. Substantive history-tool results remain eligible evidence. |

The delta's `scope` is its cumulative target interval. Its input record's `historyScope` describes newly considered history. Native retained evidence may precede this interval. Earlier delta text is a summary projection whose original input record remains available. These records describe supplied material; the agent judges relevance and verification.

Generation supplies the base checkpoint and previous delta explicitly. Raw evidence comes from the current Pi projection, with eligible messages rendered in full. Mixed assistant entries containing maintenance calls use recorded filtered projections. Input accounting includes the generation instructions and output allowance. Capacity failures preserve saved state.

Receipts, listings and recovery views show compact `inputRecord` provenance. Read the checkpoint or delta-owning compaction with `history_read` for full records and browse calls. Follow earlier delta owners to inspect inherited evidence. Missing history after a failed generation remains discoverable through the recorded ranges and branch history.

Each recovery summary is generated and saved once for its compaction. Ordinary work, checkpoints, history reads, source edits and configuration changes preserve that saved text. The next compaction uses the latest successful checkpoint and matching delta. Recovery ownership is checked against the current branch, and `recoveryBasis` identifies the checkpoint and delta represented by the saved summary. Pi supplies the raw retained tail.

Delta generation uses the current model and host authentication. Transient failures and invalid outputs share at most three attempts with cancellable backoff; authentication, invalid-request and account-limit failures go directly to recovery. Each attempt waits for a response or error, subject to cancellation. With no new eligible material or custom instructions, compaction reuses the matching delta or records an empty delta. New deltas become active with the committed pi compaction entry.

The recovery view distinguishes saved state from later changes. Later user corrections and original execution evidence can supersede saved facts; omission from a delta leaves checkpoint items intact. `requestHistoryPosition` and `compactionSnapshot` mark request boundaries. `eventsAfterDeltaInput` locates events after the delta input or checkpoint request, bounded by `compactionSnapshot`, for optional investigation. These fields describe provenance; the agent decides what requires verification. Tool calls retain matching results, and complete source entries remain in the session log.

Read known entry IDs with `history_read`. Locate evidence by browsing windows and entries or by searching a known phrase, then read the returned IDs. Retrieve the evidence needed for the next action.

## Reminders and native boundaries

Ledger Context measures new work after the later of the latest agent checkpoint request position and the latest committed compaction on the current branch. With neither, measurement starts at the branch beginning. Retained history and recovery material precede the new window's volume origin; checkpoint provenance stays unchanged. The counter covers ordinary user messages, assistant work, and ordinary tool interactions. Request capacity also includes checkpoint, history-tool, context-budget, and reminder maintenance. The volume reminder interval is 10% of the current model's context window, rounded down to at least one token. Each new interval queues one notice; a large result crossing several intervals produces one notice for the highest crossed mark. Delivered marks survive reload within their window and checkpoint origin. A model change recalculates the interval while preserving already-notified progress.

Reminders are one-time checkpoint requests scoped to their issuing window and checkpoint baseline. Each delivery combines newly triggered work-volume and budget reasons into one notice. After a tool batch, notices use pi's native steering; after a run ends, pending reasons wait for the next normal user request and are evaluated against the current state. Urgency upgrades append a new notice. Previously delivered notices retain their original text and position, including when native compaction retains them in its tail. The scope in the text makes later delivery of an earlier window's notice identifiable as completed by that compaction.

A successful checkpoint receipt confirms that reminder requests through its recorded history position are complete. New work can trigger subsequent reminders within the same run. Delivered budget levels remain deduplicated within their window across saves and reloads. Reminders retain their custom identity in the log and Pi maps them to user messages, including when another extension forces the system prompt. Detailed measurements and source-entry ranges remain in metadata. Source selection excludes maintenance reminder records; request snapshot IDs may point to a reminder.

Known native settings use the effective boundary `B = min(W - O, W - R)`, where `W` is the model window, `O` is the extension output reserve, and `R` is pi's native compaction reserve. Disabled or unknown native settings use `B = W - O` with window protection. The reminder settings are lead times before B. For `W=500000`, `O=16384`, and `R=27200`, `B=472800`; the default soft and urgent used-token triggers are `440032` (`B - 32768`) and `456416` (`B - 16384`), with lead times of `32768` and `16384` tokens.

The package reads native settings through the public `SettingsManager`, using the current working directory, agent directory, and project trust state. An SDK host can supply its actual settings through `settingsReader`. Here, `settingsManager` is the host's existing instance; include `ledgerExtension` in the `extensionFactories` constructor option of the host's resource loader:

```ts
import { createLedgerContext } from "./src/ledger-context.ts";

const ledgerExtension = createLedgerContext({
  settingsReader: (ctx) => ({
    source: "host SettingsManager",
    compaction: settingsManager.getCompactionSettings(ctx.model ?? undefined),
  }),
});
```

Settings failures mark the native boundary as unknown and use window protection. Model, working-directory, and configuration changes recalculate the boundary.

## History recovery

The history query tools share a structured `filter`. Fields combine with AND, array values with OR, and `excludeKinds` takes precedence. Queries stay on the current session branch. History reads return original log content, including compacted or context-omitted entries. Entry text lists related context-edit IDs; reading an edit shows its target and replacement or omission. Replacement images have references under the edit entry ID and support `view: "image"`.

| Filter | Meaning |
| --- | --- |
| `kinds`, `excludeKinds` | Select or exclude `user_input`, `assistant_text`, `tool_call`, `tool_result`, `checkpoint`, `compaction_delta`, and `metadata` parts. Omission includes all kinds. |
| `toolNames` | Exact tool names; selects matching invocations and results. |
| `statuses` | Logged entry status: `received`, `requested`, `completed`, `failed`, `saved`, `committed`, or `metadata`. |
| `windowIds` | Committed window IDs or the initial window ID. |
| `afterEntryId`, `beforeEntryId` | Exclusive positions inside the branch snapshot. |
| `hasImage` | Select entries by presence of original image blocks. |
| `includeMaintenance` | Include checkpoint/history/budget tool traffic; defaults to false. Saved checkpoint records remain selectable independently. |

`history_list_items` and `history_search` return one item per source entry, with selected `kinds`, execution state, and source IDs. Search requires a nonempty literal `query` and ignores case unless `caseSensitive: true`. Matching is independent of returned content. `projection` is `all` by default: `all` returns previews and image references, `text` returns text from selected parts including mixed image entries, `images` returns image references, and `references` returns entry metadata. `maxChars` sets the per-entry preview ceiling, defaulting to 256 UTF-16 code units. Search reports the original matching `contentIndex` and offsets in the selected rendered text. Image matching uses textual metadata.

Item lists and searches return `items`, `totalMatches`, `returnedCount`, `snapshotThrough`, and `nextCursor`. `order` is `newest` by default and also accepts `oldest`. Version 4 cursors bind the branch snapshot, tool, filters, ordering, and match options. Continue with the same selection arguments; `limit`, `maxChars`, and `projection` may change between pages. Later activity leaves that snapshot stable. `limit` and `maxChars` are ceilings within the output budget. `pageEnd` reports `complete`, `limit`, or `output_budget`; a preview's truncation marker directs a full entry read. Invalid cursors explain continuation and restarting with the current query.

Checkpoint items include the prior parsed checkpoint ID, source window, request history position, and snapshot-relative `active` flag. `fitsCurrentLedgerBudget` reports current capacity independently of saved identity. New compaction summaries validate complete checkpoint and delta bodies against their limits. `compaction_delta` items identify generated delta owners, their baseline, scope and input record. Reused or stale deltas refer to the original owner.

`history_list_windows` accepts the shared filter, ordering, limit, and cursor. It includes initial and committed windows even when empty. `entryCount` and first/last entry IDs describe native window attribution; `matchedEntryCount`, `kindCounts`, `failedToolResults`, and `imageCount` use the same filter as item listing. Tool-call counts count invocations; other kinds count entries. Latest user previews quote matching inputs. Checkpoint counts, excerpts, and latest input-record provenance describe snapshots grouped by original source window independently of the filter. Preview truncation flags distinguish complete wording from excerpts. Continue with the same filter/order and an adjustable `limit`; `returnedCount` and `pageEnd` describe the page. Default history results obey `LEDGER_CONTEXT_READ_TOKENS`.

Windows separately expose `deltaStatus`, `deltaActive`, the owning compaction ID, base checkpoint, preview and `deltaInputRecord`. Checkpoint counts include agent-authored checkpoints. A window's committed delta status remains historical when a newer checkpoint becomes active.

```ts
history_search({ query: "timeout", filter: { kinds: ["tool_result"], toolNames: ["bash"], statuses: ["failed"] }, projection: "text" });
history_list_items({ filter: { kinds: ["checkpoint"] }, limit: 5 });
history_list_items({ filter: { kinds: ["compaction_delta"] }, limit: 5 });
history_read({ entryId: "result-id", view: "exchange" });
```

`get_context_remaining` is a read-only capacity snapshot. `modelRemainingTokens` measures model headroom; `tokensUntilBoundary` measures headroom before the effective boundary. `usageKind` distinguishes `pi-context-usage`, `projected-content-estimate`, and unavailable data; unavailable numeric values are null. Pi controls compaction timing.

`history_read` defaults to `view: "entry"` and accepts `projection`, an optional original `contentIndex`, and UTF-16 `offset`/`length` pagination. `offset` defaults to 0 and `length` to 65536. Copy `nextRead` to continue with the same projection and block, or use `nextOffset` with those parameters. Results report requested/returned lengths, total length, and `pageEnd`: `complete`, `length`, or `output_budget`.

`view: "exchange"` follows a tool call and every matching result up to reuse of that call ID; a result anchor selects its nearest preceding invocation. `contentIndex` can select one invocation in a multi-call message. Missing calls/results are reported explicitly. `view: "neighbors"` reads chronological log entries around an anchor, with `before` and `after` defaulting to 2 and bounded at 20. These related views use `limit`/`cursor`/`order`, default to oldest-first order, and preserve a snapshot. Keep the same anchor, range, and order when continuing; `limit` and `projection` may change. View conflicts name the offending fields and the appropriate paging controls. Neighborhoods express log proximity. The session log remains the evidence source.

Read a single-block search match with its `contentIndex` and `offset`, plus the desired UTF-16 `length`. Block-selected reads use the same rendered block coordinates as search; entry metadata stays outside the sliced text. Matches with `spansBlocks: true` or without a content index use the entry ID for complete evidence. Empty assistant responses remain discoverable as metadata, including recorded stop reasons and errors.

Tool-call pairing metadata in listings and search results fits the output budget. `omittedToolCalls` reports calls left out of that metadata; use the entry ID with `history_read` to recover the complete call details.

`truncate: false` opts out of budget clipping for the selected query or read. Explicit `length`, `maxChars` and `limit` still define the requested range. With no text length/preview limit, exact mode returns complete selected text. `history_read({ view: "many", items: [{ entryId: "a" }, { entryId: "b", offset: 100, length: 200 }], truncate: false })` reads up to 100 selections in order. Many items support entry and image views, share one branch snapshot and report per-item errors. Default many output uses one shared budget; copy `nextRead`, including its snapshot, to continue. Returned results remain fixed in the transcript.

### Image reads

Use `history_read({ entryId, view: "image", contentIndex })` to load the image at `pi://entry/<id>/content/<index>`. The extension validates the selected block and base64 payload, and returns its source bytes with a source note and provenance.

Pi normalizes tool-result images before they enter history, using its auto-resize setting and the current model's image profile. The extension records source metadata; Pi owns resulting dimensions, formats and provider encoding. History output budgeting includes an image token estimate. Unsupported model input, invalid selection and output-capacity failures are explicit and source-bearing.

Successful images enter history as Pi-processed tool-result blocks. Later main-agent requests preserve Pi's projected messages and tool pairing.

## Configuration and budgets

All extension settings use the `LEDGER_CONTEXT_` namespace. Token budget values are positive integers. `LEDGER_CONTEXT_URGENT_TOKENS` is smaller than `LEDGER_CONTEXT_REMINDER_TOKENS`.

| Setting | Default | Purpose |
| --- | --- | --- |
| `LEDGER_CONTEXT_REMINDER_TOKENS` | `max(2, floor(min(window × 0.20, 32768)))` | Soft reminder lead time before the effective boundary; the used-token trigger is `B - lead time` |
| `LEDGER_CONTEXT_URGENT_TOKENS` | `max(1, min(default soft lead time − 1, floor(min(window × 0.10, 16384))))` | Urgent reminder lead time before the effective boundary; the used-token trigger is `B - lead time` |
| `LEDGER_CONTEXT_LEDGER_TOKENS` | `4096` | Estimated token limit for an agent checkpoint |
| `LEDGER_CONTEXT_DELTA_TOKENS` | `2048` | Estimated token limit for a cumulative compaction delta |
| `LEDGER_CONTEXT_READ_TOKENS` | `2048` | Default total output estimate for one history query/read, including image estimates; `truncate: false` opts out for that call |
| `LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS` | `max(1, floor(min(window × 0.10, 16384)))` | Headroom used for capacity reporting, reminders and compaction recovery budgets |

Pi owns main-agent request capacity, image handling, provider encoding and retained-tail selection. Extension limits govern checkpoint/delta bodies, new recovery summaries and default history-tool outputs. Explicit `truncate: false` returns the requested history ranges in full; Pi/provider capacity still applies.

Checkpoint and delta bodies each allow 65,536 UTF-8 bytes and up to 8 source selectors; quotes allow 512 UTF-16 units and each selector retains up to 4 matching entries. Search text allows 8,192 UTF-8 bytes, identifiers 1,024 UTF-16 units, and pages or many batches up to 100 items. Explicit text offsets and lengths are safe integers. Default entry reads request 65,536 UTF-16 units; exact reads without a length return all remaining text.

Pi context usage combines the provider's reported usage with estimates for subsequent messages. When provider usage is unknown, Ledger Context estimates the projected conversation and recovery material, then counts the system prompt, active tools and model metadata once. These estimates feed capacity reports, reminders and compaction recovery budgets. Their accuracy depends on the model's token accounting.

## Recovery states

- Delta state is `generated`, `reused`, `empty`, `stale`, or `unavailable`. Generation failure preserves the checkpoint and earlier matching delta; retained messages and source references support subsequent work.
- New recovery summaries contain complete checkpoint and delta bodies within their configured limits. Capacity errors preserve saved records and the existing recovery text.
- Normal compaction cancellation and invalid checkpoint input preserve the previous valid window and checkpoint.
- Pi prepares compaction before invoking the extension. Insufficient summarizable content returns `Nothing to compact`, including for manual `/compact` with custom instructions. The checkpoint, delta and window remain unchanged; checkpoint saves remain available independently.
- A persistent session log failure stops the current run and future saves or compactions. Reopen the persisted file with a fresh public `SessionManager` to resume durable recovery.
- Fork, tree, resume, reload, new session, and model changes rebuild state from the selected branch. Each branch keeps its own ledger, window records, and pending reminder provenance.
