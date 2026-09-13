# pi Ledger Context Extension

Ledger Context keeps a bounded working ledger in the pi session log and carries it into a deterministic recovery bootstrap at native context compaction. The extension uses pi's public `ExtensionAPI` and SDK.

## Requirements

- Runtime baseline: `@earendil-works/pi-coding-agent` 0.85.1 with Node.js `>=22.19.0`.
- Keep pi native automatic compaction enabled for automatic window changes. Pi owns the compaction threshold, session log, steering and follow-up queues, overflow retry, and compaction lifecycle.
- Configure one compaction content extension per session. Ledger Context supplies the compaction summary and recovery bootstrap for each window.
- Automatic compaction disabled mode keeps `checkpoint`, `history_read`, `history_search`, and manual `/compact` available.

## Installation

From the checkout root, install this package as a local pi package. The manifest loads `src/ledger-context.ts`.

```bash
pi install -l .
```

The package registers these model tools:

- `checkpoint` saves a complete active ledger and returns its persistence scope and handoff state.
- `history_search` searches literal text on the current branch, ignoring case by default; `caseSensitive: true` requires exact case.
- `history_read` reads a bounded text slice or one selected image from a referenced current-branch entry.

## Checkpoints and recovery

Call `checkpoint` with the complete active ledger and optional current-branch user request entry IDs. A successful receipt contains the checkpoint entry ID, source window ID, request history position, estimated ledger size, persistence scope, and `awaiting-native-compaction-threshold` handoff state.

Keep the ledger brief: goal and status, constraints and decisions, verified results and evidence, next step or wait condition, recovery references, and useful available skills or “none.” Use paths and entry IDs for detail, distinguish plans from completed work, and redact secrets.

The bootstrap identifies the previous checkpoint, latest user request, and latest completed assistant answer. `requestHistoryPosition` records the log position at the start of the model request that produced the checkpoint; `pendingHistoryRange` identifies subsequent events. These positions locate evidence and do not prove it was read, understood, or reflected in the ledger. Use the retained text or read missing entries to verify the state before continuing actions with side effects.

Saving a checkpoint lets the current run continue. Pi controls compaction timing. Automatic compaction and manual `/compact [instructions]` use the same recovery bootstrap. With an existing checkpoint, the bootstrap is built directly from the ledger and session entries. When a checkpoint is missing, the extension tries one ledger-generation request using the current model, host authentication, and bounded history excerpts. It waits for the response or an error, subject to user cancellation. Valid output is saved as a checkpoint and included in recovery. Generation errors or invalid output use the existing recovery range and history references. User cancellation cancels compaction; a checkpoint write failure stops recovery until the persisted session is reopened.

The bootstrap carries the latest ledger, current task and latest user wording, window metadata, bounded recent interaction, execution state, and direct history references. Assistant tool calls stay paired with every matching result. Persistent sessions keep complete entries in the pi session log as the durable evidence source; in-memory sessions keep them for the current process.

Use a known entry ID with `history_read` first. Use `history_search` to locate missing evidence, then read the returned ID. Stop retrieving history once the evidence needed for the next action is available.

## Reminders and native boundaries

Ledger Context measures new work from the active checkpoint request position, or from the current window start when no checkpoint exists. Ordinary user messages, assistant work, and tool interactions count toward this volume. Checkpoint, history-tool, and reminder maintenance are excluded from the volume but still consume request capacity. The volume reminder interval is 10% of the current model's context window, rounded down to at least one token. Each new interval queues one notice; a large result crossing several intervals produces one notice for the highest crossed mark. Delivered marks survive reload, and a model change recalculates the interval while preserving already-notified progress. A successful checkpoint resets the volume origin. `LEDGER_CONTEXT_TAIL_TOKENS` controls retained history independently.

A completed interactive or RPC user run with ordinary work and no successful checkpoint update queues one notice for the next qualifying user run. Extension-origin work, tool continuations, retries, queued steering, and maintenance belong to the current run. Pending reasons are combined into one notice and deduplicated separately. Reminders use pi's native steering or the next normal request boundary while ordinary work continues.

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

`history_search` searches literal substrings, ignoring case by default. Set `caseSensitive: true` for exact case. It returns newest-first hits with bounded excerpts and `nextCursor`; snippets preserve the original text and offsets. Its `scope` is `conversation` by default for user and assistant text; `tools` selects ordinary tool calls and results; `all` includes every searchable entry. Window and role filters narrow the current branch. Cursors preserve the original snapshot and filters, including `caseSensitive`, across later activity; an invalid cursor returns an error with instructions to search again.

`history_read` accepts `offset` and `length` for bounded text pagination and returns `nextOffset` when more text remains. Offsets and lengths use UTF-16 code units. Results identify the source role, window, execution status, entry reference, and payload references. The session log preserves the complete original entries.

### Image reads

Pass `imageIndex` to `history_read` to select the original image block index in the source entry's content array. The index maps to `pi://entry/<id>/content/<index>`. Image mode is mutually exclusive with `offset` and `length`. Each successful call returns one normalized `ImageContent` block, a bounded source note, and provenance with the source entry, window, dimensions, MIME types, and encoded and decoded sizes.

Image reads require an image-capable model and valid image bytes. Pi's public image utilities normalize a copy to at most 2000 by 2000 pixels and less than 4.5 MiB of base64 payload. Invalid, unavailable, unsupported, and capacity-limited selections return an explicit text error with the source reference.

Images that fit the request budget appear in the next actual provider request, including across native compaction or a batch containing large ordinary results and multiple image reads. Every tool call stays paired with its matching results. Images that cannot fit are replaced in that request by text errors with source references. If even the minimum request containing those errors and mandatory context cannot fit, the run stops with a capacity error. Later requests may represent already-delivered images with metadata references.

## Configuration and budgets

All seven extension settings use the `LEDGER_CONTEXT_` namespace. Every configured value is a positive integer. `LEDGER_CONTEXT_URGENT_TOKENS` is smaller than `LEDGER_CONTEXT_REMINDER_TOKENS`.

| Setting | Default | Purpose |
| --- | --- | --- |
| `LEDGER_CONTEXT_REMINDER_TOKENS` | `max(2, floor(min(window × 0.20, 32768)))` | Soft reminder lead time before the effective boundary; the used-token trigger is `B - lead time` |
| `LEDGER_CONTEXT_URGENT_TOKENS` | `max(1, min(default soft lead time − 1, floor(min(window × 0.10, 16384))))` | Urgent reminder lead time before the effective boundary; the used-token trigger is `B - lead time` |
| `LEDGER_CONTEXT_LEDGER_TOKENS` | `4096` | Estimated token limit for a saved ledger |
| `LEDGER_CONTEXT_TASK_TOKENS` | `max(1, floor(window × 0.05))` | Estimated token limit for task and request recovery text |
| `LEDGER_CONTEXT_TAIL_TOKENS` | `max(1, floor(window × 0.05))` | Estimated token limit for recent interaction display |
| `LEDGER_CONTEXT_READ_TOKENS` | `2048` | Total estimated output for one `history_read` or `history_search` result; image reads include source metadata, the note, and the image estimate |
| `LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS` | `max(1, floor(min(window × 0.10, 16384)))` | Output space reserved in each conservative request budget |

Each request budget includes the system prompt, active tool schemas and prompt guidelines, model metadata, selected messages and recovery content, and output reserve. Mandatory active tool protocol and fresh images may exceed the recent-tail limit when the full request fits; optional history stays within its allocation. Image reads also obey the total `LEDGER_CONTEXT_READ_TOKENS` limit.

Ledger input has a `65,536` UTF-8 byte limit and accepts at most `8` active request references. History queries allow up to `8,192` UTF-8 bytes, identifiers up to `1,024` UTF-16 code units, and search pages up to `100` results. Text reads accept a maximum length of `65,536` UTF-16 code units. These input limits apply alongside the output budgets.

Pi context usage combines the provider's reported usage with estimates for subsequent messages. When provider usage is unknown, Ledger Context estimates the bounded messages, system prompt, active tools, and model metadata sent in the request. Full request capacity adds output reserve separately. Text and image estimates guide capacity decisions; their accuracy depends on the model's token accounting.

## Recovery states

- A missing checkpoint triggers one generation attempt; a failed attempt or stale checkpoint uses an explicit recovery range and direct history references.
- Normal compaction cancellation and invalid checkpoint input preserve the previous valid window and checkpoint.
- A persistent session log failure stops the current run and future saves or compactions. Reopen the persisted file with a fresh public `SessionManager` to resume durable recovery.
- Fork, tree, resume, reload, new session, and model changes rebuild state from the selected branch. Each branch keeps its own ledger, window records, and pending reminder provenance.
