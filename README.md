# opencode-to-atif-traces

OpenCode plugin to export [Agent Trajectory Interchange Format (ATIF)](https://www.harborframework.com/docs/agents/trajectory-format) traces.

## Usage

Set the `ATIF` env var to the output path and run `opencode` as you normally would:

```bash
ATIF=traces.jsonl \
  opencode run "Refactor the XML parser to use a tree structure."
```

Tracing happens in the background, so you still get the normal stdout / stderr output from `opencode` in your terminal. This is in contrast with OpenCode's native `--format=json`, which replaces stdout with the JSON event stream and makes the run much less pleasant to watch interactively.

## Status

Work in progress, and not yet battle-tested. The plan is to add tests that mirror the Harbor team's implementation, and to keep the schema in sync as ATIF evolves.

Contributions, issues, and feedback are very welcome. Please open an issue or PR if something is broken or could be better.

## Acknowledgements

- Event subscription and emission (`tool_use`, `step_start`, `step_finish`, `text`, `reasoning`) follows OpenCode's own JSON-format path in [`packages/opencode/src/cli/cmd/run.ts`](https://github.com/anomalyco/opencode/blob/62e1335388fdbadaa95d258b43f1c84740e6db1d/packages/opencode/src/cli/cmd/run.ts#L420-L553).
- Per-event ingest that groups events into turns by `step_start` / `step_finish` is based on the Harbor team's [`src/harbor/agents/installed/opencode.py`](https://github.com/harbor-framework/harbor/blob/main/src/harbor/agents/installed/opencode.py) (see commit [`6752089`](https://github.com/harbor-framework/harbor/commit/67520896b28db9b0b21ed64eac9501b1e5c7138c)).

## License

MIT
