# pi-ledger-compact

Preserves the main agent's working state across Pi context compactions with
agent-authored checkpoints, cumulative compaction deltas, and branch-scoped
history tools.

## Requirements and Quickstart

- Node.js `>=22.19.0` with `@earendil-works/pi-coding-agent` and
  `@earendil-works/pi-ai` `>=1.5.0 <2.0.0` (tested on Pi `1.5.0`).
- Keep Pi native automatic compaction enabled for automatic window transitions,
  with this package as the session's single compaction content extension.

Install from the repository root (loads [`src/ledger-context.ts`](src/ledger-context.ts)):

```sh
pi install -l .
```

## Workflow and Example

The extension registers six tools for the main agent:

- `checkpoint`: saves state whole (`ledger`) or as exact replacements (`edits`),
  with optional `sourceQuotes` and `compact` (`"continue"` or `"stop"`).
- `history_read`: reads paged entry text, an image block, a tool exchange
  (`view: "exchange"`), neighbors (`view: "neighbors"`), or a batch (`view: "many"`).
- `history_search` and `history_list_items`: find literal text or list filtered
  entries, checkpoints, and compaction deltas.
- `history_list_windows`: lists context windows with counts and previews.
- `get_context_remaining`: reports context usage, new work since the latest
  checkpoint or compaction, and `tokensUntilBoundary`.

After a tool batch, a one-line notice reports context use and new work each
time the context reaches another 5% of the model window; checkpoint reminders
state the context use too. After compaction, the recovery summary directs the
model to list user inputs with `history_list_items`, read needed entries with
`history_read`, and reconcile them with the checkpoint before continuing. When
`LEDGER_CONTEXT_RECOVERY_NUDGE=1`, a hidden steer notice reminds the model once
per compacted window if it runs ordinary tools without inspecting history first.

Example arguments for the agent's `checkpoint` tool:

```json
{
  "ledger": "Goal: investigate intermittent timeouts.\nNext: inspect failed shell calls.",
  "compact": "continue"
}
```

## Key Constraints

- **Model-only tools**: All six tools use `exposure: "model-only"`. They stay
  directly declared to the model (including under `codemode.mode: "only"`) and
  cannot be called from `codemode` scripts. Optional parameters accept `null` as omitted.
- **Checkpoints, edits, and compaction**: `checkpoint` takes either `ledger` (up
  to `65536` UTF-8 bytes and `LEDGER_CONTEXT_LEDGER_TOKENS`, default `8192`) or
  disjoint `edits` against the saved checkpoint plus any `## Folded compaction changes`
  delta. Omitting `sourceQuotes` (or passing `null`) keeps up to `8` saved
  references on both `ledger` and `edits`, non-empty `sourceQuotes` replaces
  the list (and keeps the saved state when given alone), and `[]` with `ledger`
  or `edits` clears it. `compact: "continue"` compacts after the current tool
  batch; `"stop"` compacts after the final reply before settling. Both keep up
  to Pi's `keepRecentTokens` before the `checkpoint` call when budget permits;
  when zero preceding entries are kept and the `checkpoint` call is the only
  tool call of its message, the call and its receipt leave with earlier history
  so the ledger appears once, in the recovery summary; what follows the receipt
  stays.
- **Usage notices and recovery nudges**: `LEDGER_CONTEXT_USAGE_NOTICE_PERCENT`
  sets the usage notice step in percent of the model window (default `5`); `0`
  turns them off. `LEDGER_CONTEXT_RECOVERY_NUDGE` (`0` or `1`, default `0`)
  enables the once-per-compaction recovery nudge after ordinary tool batches
  when no history tool has run in the new window.
- **Schema and failure safety**: Recovery records require schema version `6`
  (no automatic migration). Delta generation failures or input capacity overflows
  preserve the saved checkpoint and earlier matching delta.
- **Session log write failures**: Pi drops an entry it cannot write. A failed
  checkpoint save aborts the active run and keeps the previous checkpoint; the
  next request continues from the persisted session.
- **Context reserve vs. generation limit**: `LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS`
  reserves context-window headroom for boundaries, reminders, and recovery
  summaries; it does not cap LLM output generation.

## Testing and Reference

```sh
npm run test:docker
```

Requires Docker and network access. The script typechecks and tests Pi `1.5.0`
in temporary containers with source mounted read-only.

See [`docs/reference.md`](docs/reference.md) and [`src/ledger-context.ts`](src/ledger-context.ts).
License: MIT.
