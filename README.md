# pi Ledger Context Extension

Ledger Context preserves the main agent's working checkpoint and a separate cumulative compaction delta in the pi session log. Each model request uses the current recovery baseline through pi's public `ExtensionAPI` and SDK.

## Requirements

- Runtime baseline: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` 0.87.x with Node.js `>=22.19.0`; development dependencies are pinned to 0.87.0.
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

Call `checkpoint` with the complete current working state and optional current-branch user request entry IDs. Integrate still-needed facts from the current checkpoint, subsequent delta and recent work. A successful save replaces the active baseline, retains earlier versions in history, and reports its entry ID, source window, request position, size and persistence scope. Pi controls compaction timing.

Keep the ledger brief: goal and status, constraints and decisions, verified results and evidence, next step or wait condition, recovery references, and useful available skills or “none.” Use paths and entry IDs for detail, distinguish plans from completed work, and redact secrets.

Only the main agent's `checkpoint` tool writes checkpoints. Its prompt asks for the current working state. The compaction prompt asks for subsequent changes: user corrections, decisions, execution outcomes, verification and changed next steps. It receives the checkpoint as read-only background, the previous matching delta as a summary, and bounded new evidence. Repeated compactions update the cumulative delta while preserving the checkpoint text. With no checkpoint, the origin is the branch beginning.

Recovery records use schema version 5. Start a new session when switching from an earlier recovery schema, including version 4. Original logs remain intact; incompatible or corrupt recovery records stop resume with an explicit error.

Pi's `buildSessionProjection()` supplies the effective messages for request projection, retained-tail selection and automatic delta history. Current-branch context edits control omission and replacement. Explicit task anchors and the latest user request remain available across compactions, with the latest branch edits applied to their text. New replacements of retained earlier evidence qualify for the next delta. Replacement text cites its edit record, which also owns replacement-image references. Original entries, checkpoints and delta records remain the history and provenance source.

Context edits govern subsequent selection of source text. Existing checkpoint and delta prose keeps its recorded meaning; the main agent can save a revised checkpoint when previously summarized facts need correction.

Each `inputCoverage` is an immutable input record. Agent checkpoints use `measurement: "unmeasured"`, `source: "agent-context"`, `snapshotThrough`, and `recoveryBasis`: the checkpoint/delta IDs projected for the generating main-agent request, or null when no recovery view was supplied. Delta requests use `measurement: "measured"` and `source: "compaction-delta"` with these fields:

| Field | Meaning |
| --- | --- |
| `measurement`, `source`, `snapshotThrough` | Measurement availability, generation path, and request snapshot tip. All input records contain these fields. |
| `baseCheckpointEntryId`, `baseDeltaCompactionEntryId` | Checkpoint and earlier generated delta actually supplied as bases, or null. |
| `historyScope` | Measured requests: the historical selection interval, after `afterEntryId` exclusively through `throughEntryId` inclusively. A null lower bound starts at the branch beginning. |
| `representation` | `rendered-text-with-image-references`: supplied text includes image references; pixels require a separate image read. |
| `fullRanges` | Inclusive ranges whose complete rendered entry text was supplied to this delta request. |
| `partialEntries` | Original rendered text prefixes: source entry ID, positive `providedChars`, and larger `totalChars`, in UTF-16 units. |
| `projections` | `reference`, `checkpoint-ledger`, `delta-ledger`, `filtered-entry`, or `context-edit`, with source IDs and supplied/total UTF-16 lengths of projection text. `context-edit` also records `editEntryId` for the applied replacement. |
| `omittedRanges` | Inclusive ranges within `historyScope` left out of the bounded input, with entry counts. |
| `excludedRanges` | Inclusive ranges excluded as `maintenance`, `structural-metadata`, `context-omitted` (explicit omission), or `inactive-context` (outside Pi's active projection). Explicit task anchors and substantive history-tool results remain eligible evidence. |

The delta's `scope` spans its cumulative target interval. Its input record's `historyScope` spans the new history considered for that request. Task anchors may precede this interval. Earlier delta text counts as a summary projection; its original sources retain their earlier input records. Relevance, understanding and verification remain judgments supported by evidence during ordinary agent work.

Generation receives the base checkpoint and previous delta explicitly. Compaction packets and complete manifests stay in the log, keeping repeated generation input bounded. Mixed assistant entries with maintenance calls use filtered projections; ordinary evidence retains its rendering, including any quotations.

Receipts, listings and recovery views show compact `inputRecord` provenance. Read the checkpoint or delta's owning compaction entry with `history_read`, following `nextRead` for full details. Generated delta records include optional browse calls for omitted ranges, partial text and projected sources. Choose evidence according to the current task.

After compaction, each main-agent request projects the latest checkpoint and its matching delta into the extension's recovery summary. A new checkpoint immediately becomes the baseline; earlier checkpoint/delta versions remain readable in history. The persisted compaction packet keeps its task/tail source IDs and optional custom instructions. Each request renders those sources with current branch edits and budgets, including edits appended after compaction, while the packet remains unchanged. Recovery ownership is checked against the current branch before projection.

Delta generation uses the current model and host authentication. Transient failures and invalid outputs share at most three attempts with cancellable backoff; authentication, invalid-request and account-limit failures go directly to recovery. Each attempt waits for a response or error, subject to cancellation. With no new eligible material or custom instructions, compaction reuses the matching delta or records an empty delta. New deltas become active with the committed pi compaction entry.

The recovery view distinguishes saved state from later changes. Later user corrections and original execution evidence can supersede saved facts; omission from a delta leaves checkpoint items intact. `requestHistoryPosition` and `compactionSnapshot` mark request boundaries. `eventsAfterDeltaInput` locates later events for optional investigation. These fields describe provenance; the agent decides what requires verification. Tool calls retain matching results, and complete source entries remain in the session log.

Read known entry IDs with `history_read`. Locate evidence by browsing windows and entries or by searching a known phrase, then read the returned IDs. Retrieve the evidence needed for the next action.

## Reminders and native boundaries

Ledger Context measures new work after the later of the latest agent checkpoint request position and the latest committed compaction on the current branch. With neither, measurement starts at the branch beginning. Retained history and recovery material precede the new window's volume origin; checkpoint provenance stays unchanged. The counter covers ordinary user messages, assistant work, and ordinary tool interactions. Request capacity also includes checkpoint, history-tool, context-budget, and reminder maintenance. The volume reminder interval is 10% of the current model's context window, rounded down to at least one token. Each new interval queues one notice; a large result crossing several intervals produces one notice for the highest crossed mark. Delivered marks survive reload within their window and checkpoint origin. A model change recalculates the interval while preserving already-notified progress. `LEDGER_CONTEXT_TAIL_TOKENS` controls retained history independently.

Reminders are triggered by accumulated work volume or budget pressure. After a tool batch, they use pi's native steering; when a run has already ended, pending reminders wait for the next normal user request. Before each model request, reminder applicability is checked again: volume notices expire when their window or checkpoint origin changes, and budget notices reflect current headroom and urgency. The request keeps at most one applicable notice per reason kind. Original reminder records remain in the log for provenance; current notice text is a request-only projection. Ordinary work continues while reminders are delivered.

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

Checkpoint items include the prior parsed checkpoint ID, source window, request history position, and snapshot-relative `active` flag. The latest checkpoint retains its identity when its budget shrinks; `fitsCurrentLedgerBudget` reports whether it fits. Full recovery capacity is checked at compaction and each request. `compaction_delta` items identify compaction entries that generated a delta, with their base checkpoint, scope, input record and active flag. Reused or stale deltas refer to that original owner.

`history_list_windows` accepts the shared filter, ordering, limit, and cursor. It includes initial and committed windows even when empty. `entryCount` and first/last entry IDs describe native window attribution; `matchedEntryCount`, `kindCounts`, `failedToolResults`, and `imageCount` use the same filter as item listing. Tool-call counts count invocations; other kinds count entries. Latest user previews quote matching inputs. Checkpoint counts, excerpts, and latest input-record provenance describe snapshots grouped by original source window independently of the filter. Preview truncation flags distinguish complete wording from excerpts. Continue with the same filter/order and an adjustable `limit`; `returnedCount` and `pageEnd` describe the page. Successful history results obey `LEDGER_CONTEXT_READ_TOKENS`.

Windows separately expose `deltaStatus`, `deltaActive`, the owning compaction ID, base checkpoint, preview and `deltaInputRecord`. Checkpoint counts include agent-authored checkpoints. A window's committed delta status remains historical when a newer checkpoint becomes active.

```ts
history_search({ query: "timeout", filter: { kinds: ["tool_result"], toolNames: ["bash"], statuses: ["failed"] }, projection: "text" });
history_list_items({ filter: { kinds: ["checkpoint"] }, limit: 5 });
history_list_items({ filter: { kinds: ["compaction_delta"] }, limit: 5 });
history_read({ entryId: "result-id", view: "exchange" });
```

`get_context_remaining` is a read-only capacity snapshot. `modelRemainingTokens` measures model headroom; `tokensUntilBoundary` measures headroom before the effective boundary. `usageKind` distinguishes pi-reported usage, bounded estimates, and unavailable data; unavailable numeric values are null. Pi controls compaction timing.

`history_read` defaults to `view: "entry"` and accepts `projection`, an optional original `contentIndex`, and UTF-16 `offset`/`length` pagination. `offset` defaults to 0 and `length` to 65536. Copy `nextRead` to continue with the same projection and block, or use `nextOffset` with those parameters. Results report requested/returned lengths, total length, and `pageEnd`: `complete`, `length`, or `output_budget`.

`view: "exchange"` follows a tool call and every matching result up to reuse of that call ID; a result anchor selects its nearest preceding invocation. `contentIndex` can select one invocation in a multi-call message. Missing calls/results are reported explicitly. `view: "neighbors"` reads chronological log entries around an anchor, with `before` and `after` defaulting to 2 and bounded at 20. These related views use `limit`/`cursor`/`order`, default to oldest-first order, and preserve a snapshot. Keep the same anchor, range, and order when continuing; `limit` and `projection` may change. View conflicts name the offending fields and the appropriate paging controls. Neighborhoods express log proximity. The session log remains the evidence source.

Read a single-block search match with its `contentIndex` and `offset`, plus the desired UTF-16 `length`. Block-selected reads use the same rendered block coordinates as search; entry metadata stays outside the sliced text. Matches with `spansBlocks: true` or without a content index use the entry ID for complete evidence. Empty assistant responses remain discoverable as metadata, including recorded stop reasons and errors.

Tool-call pairing metadata in listings and search results fits the output budget. `omittedToolCalls` reports calls left out of that metadata; use the entry ID with `history_read` to recover the complete call details.

### Image reads

Use `history_read({ entryId, view: "image", contentIndex })` to load the original image block identified by `pi://entry/<id>/content/<index>`. This view accepts the entry ID and content index. Each successful call returns one normalized `ImageContent` block, a bounded source note, and provenance with the source entry, window, dimensions, MIME types, and encoded and decoded sizes.

Image reads require an image-capable model and valid image bytes. Pi's public image utilities normalize a copy using the stricter of the current model's `inputLimits.images.resize` profile and the extension's 2000-by-2000-pixel, 4.5-MiB base64 limits. The model's JPEG quality setting also applies. Provenance describes the normalized result delivered to Pi. Invalid, unavailable, unsupported, and capacity-limited selections return an explicit text error with the source reference.

Images that fit the request budget appear in the next actual provider request, including across native compaction or a batch containing large ordinary results and multiple image reads. Every tool call stays paired with its matching results. Images that cannot fit are replaced in that request by text errors with source references. If even the minimum request containing those errors and mandatory context cannot fit, the run stops with a capacity error. Later requests may represent already-delivered images with metadata references.

For `openai-responses`, outgoing tool images are attached as user content after the complete tool-result batch, labeled with their source call IDs. Tool results retain their text and pairing; the session log retains the original image blocks.

## Configuration and budgets

All extension settings use the `LEDGER_CONTEXT_` namespace. Every configured value is a positive integer. `LEDGER_CONTEXT_URGENT_TOKENS` is smaller than `LEDGER_CONTEXT_REMINDER_TOKENS`.

| Setting | Default | Purpose |
| --- | --- | --- |
| `LEDGER_CONTEXT_REMINDER_TOKENS` | `max(2, floor(min(window × 0.20, 32768)))` | Soft reminder lead time before the effective boundary; the used-token trigger is `B - lead time` |
| `LEDGER_CONTEXT_URGENT_TOKENS` | `max(1, min(default soft lead time − 1, floor(min(window × 0.10, 16384))))` | Urgent reminder lead time before the effective boundary; the used-token trigger is `B - lead time` |
| `LEDGER_CONTEXT_LEDGER_TOKENS` | `4096` | Estimated token limit for an agent checkpoint |
| `LEDGER_CONTEXT_DELTA_TOKENS` | `2048` | Estimated token limit for a cumulative compaction delta |
| `LEDGER_CONTEXT_TASK_TOKENS` | `max(1, floor(window × 0.05))` | Estimated token limit for task and request recovery text |
| `LEDGER_CONTEXT_TAIL_TOKENS` | `max(1, floor(window × 0.05))` | Estimated token limit for recent interaction display |
| `LEDGER_CONTEXT_READ_TOKENS` | `2048` | Total estimated output for one history query or read; image reads include source metadata, the note, and the image estimate |
| `LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS` | `max(1, floor(min(window × 0.10, 16384)))` | Output space reserved in each conservative request budget |

Each request budget includes the system prompt, active tool schemas and prompt guidelines, model metadata, selected messages and recovery content, and output reserve. Mandatory active tool protocol and fresh images may exceed the recent-tail limit when the full request fits; optional history stays within its allocation. Image reads also obey the total `LEDGER_CONTEXT_READ_TOKENS` limit.

Checkpoint and delta text each have a `65,536` UTF-8 byte limit; checkpoints accept at most `8` active request references. History search text allows up to `8,192` UTF-8 bytes, identifiers up to `1,024` UTF-16 code units, and history pages up to `100` results. Text reads accept a maximum length of `65,536` UTF-16 code units. These input limits apply alongside the output budgets.

Pi context usage combines the provider's reported usage with estimates for subsequent messages. When provider usage is unknown, Ledger Context estimates conversation messages from the canonical session projection, then counts the system prompt, active tools and model metadata once. The `context` hook transforms conversation messages; Pi retains the system prompt and tool declarations. Full request capacity adds output reserve separately. Text and image estimates guide capacity decisions; their accuracy depends on the model's token accounting.

## Recovery states

- Delta state is `generated`, `reused`, `empty`, `stale`, or `unavailable`. Generation failure preserves the checkpoint and earlier matching delta; retained messages and source references support subsequent work.
- Saved checkpoint and delta text must fit in full. Capacity errors preserve their identity and stop the request or compaction. Restore a sufficient model/budget before asking the main agent to save a smaller checkpoint.
- Normal compaction cancellation and invalid checkpoint input preserve the previous valid window and checkpoint.
- Pi prepares compaction before invoking the extension. Insufficient summarizable content returns `Nothing to compact`, including for manual `/compact` with custom instructions. The checkpoint, delta and window remain unchanged; checkpoint saves remain available independently.
- A persistent session log failure stops the current run and future saves or compactions. Reopen the persisted file with a fresh public `SessionManager` to resume durable recovery.
- Fork, tree, resume, reload, new session, and model changes rebuild state from the selected branch. Each branch keeps its own ledger, window records, and pending reminder provenance.
