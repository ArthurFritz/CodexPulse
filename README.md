# CodexPulse

Static, local-first session performance explorer for Codex traces. Imported JSON and Codex rollout JSONL logs are parsed in the browser and are not sent to a server.

## Source layout

- `src/session-data.js` contains the demo trace, normalization, and latency helpers.
- `src/views.js` renders the graph, timeline, event stream, and JSON views.
- `src/app.js` wires browser interactions, imports, and exports.
- `src/styles.css` contains application styles.
- `src/index.template.html` is the HTML shell. The build embeds all first-party CSS and JavaScript into root `index.html` and `dist/index.html`; visualization libraries load from CDNs. The generated root page can also be opened directly with `file://`.

## Development

Requires Node.js 20 or newer. No package installation is needed.

```sh
npm test
npm run build
```

The build writes the deployable single-file site to `dist/index.html` and refreshes the directly openable root `index.html`. The GitHub Actions workflow validates the app and publishes `dist/` to GitHub Pages on pushes to `main`. In repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**.

Codex rollout JSONL imports also show telemetry insights when the export includes them: token usage and cache ratio, time to first token, action duration percentiles, command/MCP failures, agent handoffs, file changes, context compactions, per-turn summaries, and idle gaps between turns. Action timings use Codex `item_completed` start/end fields when present. The service map groups repeated actions and MCP server/tool pairs so large exports remain navigable; selecting a node focuses its representative event.

Performance insights list each recorded MCP completion and failed command with its status, available duration, turn/call identifiers, and a link to its event when the export can correlate it. A mention of “Jarvis” in ordinary conversation is not evidence that a skill ran; skills and their timing appear only when the rollout contains an explicit invocation or lifecycle record. Skill timing is omitted when the export does not provide a measurable span.

User interaction insights count user messages and measure the gap from the immediately preceding event's end to each new user message. When that event has no recorded duration, its timestamp is treated as an instantaneous event rather than using an inferred duration. The summary reports measurable samples, accumulated delay, percentiles, and the share of the event span through the session's last event; the first user message has no preceding interval and is not measurable. These are elapsed gaps between records, not proof of active user thinking time; missing source timestamps remain unmeasurable.

Repeated calls are flagged as **loop candidates** only when the same tool name and normalized arguments occur consecutively at least three times in one identified or uniquely inferred active turn. Calls without unambiguous turn context are excluded from loop candidates; inferred grouping uses JSONL position between task lifecycle events and is labeled as a heuristic. This is a heuristic: polling and retries can be intentional. The export can show recorded action durations, but it does not provide host CPU/memory measurements or complete network spans. Turn durations can include substantial idle time, so use per-action timing and inter-turn gap summaries to distinguish active work from pauses. Cached tokens are included in input tokens, and cumulative token snapshots are not added again.

The interface separates Overview, Events, Performance, Models & orchestration, and Raw data. Event selection opens a dialog with previous/next navigation in chronological order. Clicking a turn summary in Performance opens that turn's event details. Long durations switch to minutes and hours. Rollout model configuration is shown from `turn_context`; model-to-agent/skill attribution and human approval waits are shown only when explicit telemetry supports them.

For paired tool calls, event details separate the call-to-output wait span from any item_completed command span. The analysis shows intervening progress records, long telemetry gaps, and nearby execution spans as indirect context when there is no shared call ID; it never labels a silent gap as approval or continuous process runtime without explicit evidence. Event input/output/raw sections remain collapsed until opened.
