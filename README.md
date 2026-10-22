# pi-ledger-compact

Preserves the main agent's working state across Pi context compactions with
agent-authored checkpoints, cumulative compaction deltas, and branch-scoped
history tools.

## Requirements and Quickstart

- Node.js `>=22.19.0` with `@earendil-works/pi-coding-agent` and
  `@earendil-works/pi-ai` `>=1.1.0 <2.0.0` (tested on Pi `1.3.0` and `1.4.0`).
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
  to `65536` UTF-8 bytes and `LEDGER_CONTEXT_LEDGER_TOKENS`, default `4096`) or
  disjoint `edits` against the saved checkpoint plus any `## Folded compaction changes`
  delta. `compact: "continue"` compacts after the current tool batch; `"stop"`
  compacts after the final reply before settling.
- **Schema and failure safety**: Recovery records require schema version `6`
  (no automatic migration). Delta generation failures or input capacity overflows
  preserve the saved checkpoint and earlier matching delta.
- **Persistence uncertainty**: A session log write failure aborts the active run
  and blocks saves and compactions until the persisted session is reopened.
- **Context reserve vs. generation limit**: `LEDGER_CONTEXT_OUTPUT_RESERVE_TOKENS`
  reserves context-window headroom for boundaries, reminders, and recovery
  summaries; it does not cap LLM output generation.

## Testing and Reference

```sh
npm run test:docker
```

Requires Docker and network access. The script typechecks and tests Pi `1.3.0`
and `1.4.0` in temporary containers with source mounted read-only.

See [`docs/reference.md`](docs/reference.md) and [`src/ledger-context.ts`](src/ledger-context.ts).
License: MIT.
