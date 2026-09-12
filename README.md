# pi Ledger Context Extension

Ledger Context stores a bounded active ledger in the pi session log and carries it into the deterministic bootstrap for the next native context compaction. It uses pi's public ExtensionAPI and SDK.

## Requirements

- Runtime baseline: `@earendil-works/pi-coding-agent` 0.85.1 with Node.js `>=22.19.0`.
- Keep pi native automatic compaction enabled for automatic window changes. Pi owns the compaction threshold, session log, steering and follow-up queues, overflow retry, and compaction lifecycle.
- Configure one compaction content extension per session. Ledger Context supplies the compaction summary and recovery bootstrap so each window has one authoritative content source.
- Automatic compaction disabled mode keeps `checkpoint`, `history_read`, `history_search`, and manual `/compact` available.

## Installation

From the checkout root, install this package as a local pi package. The manifest loads `src/ledger-context.ts`.

```bash
pi install -l .
```

The package exposes one extension entry and registers these model tools:

- `checkpoint` saves a complete active ledger and returns its persistence scope and handoff state.
- `history_search` performs case-sensitive literal search on the current branch.
- `history_read` reads a bounded slice of a referenced current-branch entry.

## Checkpoints and windows

Call `checkpoint` with the complete active ledger and optional current-branch user request entry IDs. A successful receipt contains the checkpoint entry ID, source window ID, request history position, estimated ledger size, persistence scope, and `awaiting-native-compaction-threshold` handoff state.

The checkpoint commits handoff preparation and lets the current run continue. Pi later decides when the native threshold is reached. Automatic and manual `/compact [instructions]` use the same Ledger Context bootstrap path and do not issue an independent summary-model request.

Persistent session receipts survive reopening the session log. In-memory SDK receipts cover the current process and require a persistent session for restart recovery.

The bootstrap carries the latest ledger, current task and latest user wording, window metadata, bounded recent interaction, execution state, and history references. Assistant tool calls remain paired with their tool results. Persistent sessions keep complete entries in the pi session log as the durable source of evidence; in-memory sessions keep those entries for the current process.

## History recovery

Use `history_search` with a case-sensitive literal `query`, then use the returned `entryId` with `history_read`. Search results identify the source role, committed window, execution status, match position, stable reference, and `nextCursor`. `history_read` returns bounded text with `offset`, `length`, and `nextOffset` pagination.

Queries and reads stay on the current session branch. Window and role filters narrow the result set. Image payloads return metadata and stable references so encoded data stays out of text output.

## Configuration and budgets

All seven extension settings use the `LEDGER_CONTEXT_` namespace. Every configured value is a positive integer. `LEDGER_CONTEXT_URGENT_TOKENS` must be smaller than `LEDGER_CONTEXT_REMINDER_TOKENS`.

The urgent default uses the default soft threshold; set both overrides together when a custom soft threshold needs a matching urgent threshold.

| Setting | Default | Purpose |
| --- | --- | --- |
| `LEDGER_CONTEXT_REMINDER_TOKENS` | `max(2, floor(min(window × 0.20, 32768)))` | Remaining token budget for the soft reminder |
| `LEDGER_CONTEXT_URGENT_TOKENS` | `max(1, min(default soft threshold − 1, floor(min(window × 0.10, 16384))))` | Remaining token budget for the urgent reminder |
| `LEDGER_CONTEXT_LEDGER_TOKENS` | `4096` | Estimated token limit for a saved ledger |
| `LEDGER_CONTEXT_TASK_TOKENS` | `4096` | Estimated token limit for task and request recovery text |
| `LEDGER_CONTEXT_TAIL_TOKENS` | `4096` | Estimated token limit for recent interaction display |
| `LEDGER_CONTEXT_READ_TOKENS` | `2048` | Estimated token limit for one history tool result |
| `LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS` | `max(1, floor(min(window × 0.10, 16384)))` | Output space reserved in each conservative request budget |

Each request budget includes the actual system prompt, active tool schemas and prompt guidelines, model metadata, selected recovery content, and output reserve. Ledger input also has a fixed `65,536` UTF-8 byte limit and accepts at most `8` active request references. History search accepts queries up to `8,192` bytes, identifiers up to `1,024` characters, `100` results per page, and reads up to `65,536` characters per request.

Unknown provider usage is reported as unknown and estimated from visible content. The estimate remains bounded by the model window. A tiny model window enters the explicit capacity error path when fixed context and minimum recovery metadata cannot fit; `ctx.abort()` stops the active request.

## Recovery states

- A missing or stale checkpoint behind newer work produces a bootstrap with an explicit recovery range and history references. The model can search and read the complete current branch before continuing side effects.
- A normal compaction cancellation or invalid checkpoint input preserves the previous valid window and checkpoint.
- A persistent session log write failure stops the current run and future saves or compactions. Reopen the persisted file with a fresh public `SessionManager`; a normal extension reload keeps the failed in-memory branch and does not provide recovery.
- Fork, tree, resume, reload, new session, and model changes rebuild state from the selected branch. Each branch keeps its own ledger and window records.
