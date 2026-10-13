const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('src/index.template.html');
const appScript = ['src/session-data.js', 'src/views.js', 'src/app.js'].map(read).join('\n');
const sandbox = { Date, Math, JSON, Number, String, Array, Object, RegExp, globalThis: {} };
vm.runInNewContext(appScript, sandbox);
const api = sandbox.globalThis.CodexPulse;

test('normalizes common session event envelopes and infers gaps from timestamps', () => {
  const events = api.normalizeEvents({ data: [
    { id: 'a', timestamp: '2026-01-01T00:00:00Z', type: 'user', message: 'prompt' },
    { id: 'b', timestamp: '2026-01-01T00:00:01.250Z', tool_name: 'shell', duration_ms: 340 }
  ] });
  assert.equal(events.length, 2);
  assert.equal(events[0].duration, 1250);
  assert.equal(events[1].type, 'tool');
  assert.equal(events[1].duration, 340);
});

test('handles arrays, null values, and second-based durations', () => {
  const events = api.normalizeEvents([{ type: 'llm', duration: 1.5 }, null, 'misc']);
  assert.equal(events.length, 3);
  assert.equal(events[0].duration, 1500);
  assert.equal(events[1].name, 'Event 2');
  assert.equal(events[2].name, 'misc');
});

test('calculates session wall time from event spans and accepts array roots', () => {
  const session = api.normalizeSession([{ start: 200, duration_ms: 100 }, { start: 400, duration_ms: 900 }], 'trace.json');
  assert.equal(session.name, 'trace.json');
  assert.equal(session.events.length, 2);
  assert.equal(session.total, 1300);
});

test('parses Codex rollout JSONL envelopes and pairs tool call results', () => {
  const lines = [
    { timestamp: '2026-10-06T16:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { session_id: 'rollout-1', timestamp: '2026-10-06T16:00:00.000Z' } },
    { timestamp: '2026-10-06T16:00:01.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { timestamp: '2026-10-06T16:00:02.000Z', ordinal: 2, type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{\"command\":\"pwd\"}' } },
    { timestamp: '2026-10-06T16:00:02.450Z', ordinal: 3, type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'ok' } },
    { timestamp: '2026-10-06T16:00:04.000Z', ordinal: 4, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', duration_ms: 3000 } }
  ];
  const parsed = api.parseLogText(lines.map(JSON.stringify).join('\n'), 'rollout.jsonl');
  const session = api.normalizeSession(parsed, 'rollout');
  assert.equal(session.id, 'rollout-1');
  assert.equal(session.events.length, 2);
  const tool = session.events.find((event) => event.type === 'tool');
  assert.equal(tool.name, 'shell');
  assert.equal(tool.duration, 450);
  assert.equal(tool.output, 'ok');
  assert.equal(session.events.find((event) => event.name === 'Model turn').duration, 3000);
});

test('extracts token, action timing, failure, and context insights', () => {
  const lines = [
    { timestamp: '2026-10-06T16:00:00Z', ordinal: 0, type: 'session_meta', payload: { session_id: 'insight-session' } },
    { timestamp: '2026-10-06T16:00:01Z', ordinal: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-a' } },
    { timestamp: '2026-10-06T16:00:02Z', ordinal: 2, type: 'token_usage_record', payload: { usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 120, reasoning_output_tokens: 40 } } },
    { timestamp: '2026-10-06T16:00:03Z', ordinal: 3, type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-a', started_at_ms: 1791302400000, completed_at_ms: 1791302401500, item: { type: 'CommandExecution', status: 'failed', exit_code: 1 } } },
    { timestamp: '2026-10-06T16:00:04Z', ordinal: 4, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-a', time_to_first_token_ms: 600, duration_ms: 2400 } },
    { timestamp: '2026-10-06T16:10:00Z', ordinal: 5, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-b' } },
    { timestamp: '2026-10-06T16:10:03Z', ordinal: 6, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-b', duration_ms: 2000, time_to_first_token_ms: 500 } },
    { timestamp: '2026-10-06T16:10:04Z', ordinal: 7, type: 'event_msg', payload: { type: 'item_completed', started_at_ms: 1791302404000, completed_at_ms: 1791302404100, item: { type: 'ContextCompaction' } } }
  ];
  const session = api.normalizeSession(api.parseLogText(lines.map(JSON.stringify).join('\n'), 'insights.jsonl'));
  assert.equal(session.insights.tokens.input, 1000);
  assert.equal(session.insights.tokens.cachedInputPercent, 80);
  assert.equal(session.insights.actions.CommandExecution.p95_ms, 1500);
  assert.equal(session.insights.failures.commands, 1);
  assert.equal(session.insights.firstToken.p50_ms, 600);
  assert.equal(session.insights.compacted, 1);
  assert.equal(session.insights.turns.count, 2);
  assert.equal(session.insights.idleGaps.max_ms, 596000);
  assert.equal(session.insights.turns.slowest[0].commands, 1);
});

test('detects repeated exact calls and counts MCP actions and calls', () => {
  const lines = [
    { timestamp: '2026-10-06T16:00:00Z', ordinal: 0, type: 'session_meta', payload: { session_id: 'loops' } },
    ...[1, 2, 3].map((ordinal) => ({ timestamp: `2026-10-06T16:00:0${ordinal}Z`, ordinal, type: 'response_item', payload: { type: 'function_call', id: `i${ordinal}`, turn_id: 'turn-loop', name: 'shell', call_id: `c${ordinal}`, arguments: '{\"command\":\"pwd\"}' } })),
    { timestamp: '2026-10-06T16:00:04Z', ordinal: 5, type: 'event_msg', payload: { type: 'item_completed', started_at_ms: 1791302403000, completed_at_ms: 1791302403900, item: { type: 'McpToolCall', server: 'sample-mcp', tool: 'lookup', status: 'completed' } } }
  ];
  const parsed = api.parseLogText(lines.map(JSON.stringify).join('\n'), 'loop.jsonl');
  assert.equal(parsed.insights.loops[0].repetitions, 3);
  assert.equal(parsed.insights.repeatedActions[0].count, 3);
  assert.equal(parsed.insights.mcpCalls, 1);
  assert.equal(parsed.insights.mcpGroups[0].name, 'sample-mcp / lookup');
  const session = api.normalizeSession(parsed);
  assert.equal(session.events.some((event) => event.type === 'mcp'), true);
  const unknownTurnRecords = [1, 2, 3].map((ordinal) => ({ timestamp: `2026-10-06T16:00:0${ordinal}Z`, ordinal, type: 'response_item', payload: { type: 'function_call', id: `u${ordinal}`, name: 'shell', arguments: '{"command":"pwd"}' } }));
  const unknownTurn = api.parseLogText(unknownTurnRecords.map(JSON.stringify).join('\n'), 'unknown-turn.jsonl');
  assert.equal(unknownTurn.insights.loopCandidateCount, 0);
  assert.equal(unknownTurn.insights.repeatedActions[0].count, 3);
});

test('separates long exec tool wait from nearby measured command execution', () => {
  const start = Date.parse('2026-10-08T21:54:07.019Z');
  const returned = Date.parse('2026-10-09T12:00:06.549Z');
  const execCall = { timestamp: new Date(start).toISOString(), ordinal: 1, type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call-exec', input: 'exec invocation', internal_chat_message_metadata_passthrough: { turn_id: 'turn-long' } } };
  const records = [
    { timestamp: '2026-10-08T21:25:31.592Z', ordinal: 0, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-long' } },
    execCall,
    { timestamp: new Date(start + 311).toISOString(), ordinal: 2, type: 'token_usage_record', payload: { turn_id: 'turn-long', usage: { input_tokens: 1 } } },
    { timestamp: new Date(returned).toISOString(), ordinal: 3, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-exec', output: 'Script running with cell ID 88', internal_chat_message_metadata_passthrough: { turn_id: 'turn-long' } } },
    { timestamp: new Date(returned + 1000).toISOString(), ordinal: 4, type: 'response_item', payload: { type: 'function_call', name: 'wait', call_id: 'call-wait', arguments: '{\"cell_id\":\"88\"}', internal_chat_message_metadata_passthrough: { turn_id: 'turn-long' } } },
    { timestamp: new Date(returned + 69000).toISOString(), ordinal: 5, type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-long', started_at_ms: returned + 150, completed_at_ms: returned + 68489, item: { type: 'CommandExecution', status: 'completed' } } },
    { timestamp: '2026-10-09T12:24:41.140Z', ordinal: 6, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-long', duration_ms: 53949555 } }
  ];
  const session = api.normalizeSession(api.parseLogText(records.map(JSON.stringify).join('\n'), 'long-exec.jsonl'));
  const exec = session.events.find((event) => event.id === 'call-exec');
  const turn = session.events.find((event) => event.name === 'Model turn');
  assert.equal(exec.waitAnalysis.duration_ms, returned - start);
  assert.equal(exec.waitAnalysis.records_during, 1);
  assert.equal(exec.waitAnalysis.progress_records, 0);
  assert.equal(exec.waitAnalysis.returned_while_running, true);
  assert.equal(exec.waitAnalysis.follow_up_wait_matched, true);
  assert.equal(exec.waitAnalysis.adjacent_execution.duration_ms, 68339);
  assert.equal(exec.waitAnalysis.adjacent_execution.explicitly_linked, false);
  assert.equal(turn.turnWaitAnalysis.long_tool_waits[0].call_id, 'call-exec');
});

test('does not infer a tool wait duration when the call has no paired output', () => {
  const records = [
    { timestamp: '2026-10-08T21:00:00.000Z', ordinal: 0, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-pending' } },
    { timestamp: '2026-10-08T21:00:01.000Z', ordinal: 1, type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call-pending', input: 'exec invocation', internal_chat_message_metadata_passthrough: { turn_id: 'turn-pending' } } },
    { timestamp: '2026-10-08T21:00:30.000Z', ordinal: 2, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-pending', duration_ms: 30000 } }
  ];
  const session = api.normalizeSession(api.parseLogText(records.map(JSON.stringify).join('\n'), 'pending-tool.jsonl'));
  const tool = session.events.find((event) => event.id === 'call-pending');
  const turn = session.events.find((event) => event.id === 'turn-turn-pending');

  assert.ok(tool);
  assert.equal(tool.waitAnalysis, undefined);
  assert.equal(turn.turnWaitAnalysis.tool_calls_over_800ms, 0);
  assert.deepEqual(Array.from(turn.turnWaitAnalysis.long_tool_waits), []);
});

test('counts recorded activity inside a paired tool wait as progress', () => {
  const start = Date.parse('2026-10-08T21:00:01.000Z');
  const progress = start + 5000;
  const returned = start + 20000;
  const records = [
    { timestamp: '2026-10-08T21:00:00.000Z', ordinal: 0, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-progress' } },
    { timestamp: new Date(start).toISOString(), ordinal: 1, type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call-progress', input: 'exec invocation', internal_chat_message_metadata_passthrough: { turn_id: 'turn-progress' } } },
    { timestamp: new Date(progress).toISOString(), ordinal: 2, type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-progress', started_at_ms: progress - 1000, completed_at_ms: progress, item: { type: 'Reasoning', id: 'reasoning-progress' } } },
    { timestamp: new Date(returned).toISOString(), ordinal: 3, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-progress', output: 'completed', internal_chat_message_metadata_passthrough: { turn_id: 'turn-progress' } } },
    { timestamp: new Date(returned + 1000).toISOString(), ordinal: 4, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-progress', duration_ms: returned - start + 1000 } }
  ];
  const session = api.normalizeSession(api.parseLogText(records.map(JSON.stringify).join('\n'), 'tool-progress.jsonl'));
  const tool = session.events.find((event) => event.id === 'call-progress');
  const turn = session.events.find((event) => event.id === 'turn-turn-progress');

  assert.equal(tool.waitAnalysis.duration_ms, returned - start);
  assert.equal(tool.waitAnalysis.records_during, 1);
  assert.equal(tool.waitAnalysis.progress_records, 1);
  assert.equal(tool.waitAnalysis.longest_silent_gap_ms, 15000);
  assert.equal(tool.waitAnalysis.overlapping_item_spans[0].type, 'Reasoning');
  assert.equal(turn.turnWaitAnalysis.long_tool_waits[0].call_id, 'call-progress');
});

test('extracts recorded model configuration and does not infer missing approvals or skills', () => {
  const records = [
    { timestamp: '2026-10-06T16:00:00Z', ordinal: 0, type: 'turn_context', payload: { turn_id: 'turn-model', model: 'gpt-6-luna', effort: 'medium', approval_policy: 'on-request', collaboration_mode: { mode: 'default', settings: { model: 'gpt-6-luna', reasoning_effort: 'medium' } } } },
    { timestamp: '2026-10-06T16:00:01Z', ordinal: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-model' } },
    { timestamp: '2026-10-06T16:00:02Z', ordinal: 2, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-model', duration_ms: 1000 } }
  ];
  const insights = api.parseLogText(records.map(JSON.stringify).join('\n'), 'model.jsonl').insights;
  assert.equal(insights.models[0].model, 'gpt-6-luna');
  assert.equal(insights.models[0].classification, 'GPT-6 family');
  assert.equal(insights.models[0].effort, 'medium');
  assert.equal(insights.approvalStatus, 'no explicit approval evidence');
  assert.equal(insights.skills.length, 0);
  const approvals = [
    { timestamp: '2026-10-06T16:00:00Z', ordinal: 0, type: 'event_msg', payload: { type: 'approval_requested', approval_id: 'approval-1' } },
    { timestamp: '2026-10-06T16:00:02Z', ordinal: 1, type: 'event_msg', payload: { type: 'approval_approved', approval_id: 'approval-1' } }
  ];
  const approvalInsight = api.parseLogText(approvals.map(JSON.stringify).join('\n'), 'approval.jsonl').insights;
  assert.equal(approvalInsight.approvalWaits[0].state, 'approval_approved');
  assert.equal(approvalInsight.approvalWaits[0].duration_ms, 2000);
});

test('extracts explicit skill invocations, model and measured response time without treating prose as execution', () => {
  const records = [
    { timestamp: '2026-10-06T16:00:00Z', ordinal: 0, type: 'turn_context', payload: { turn_id: 'turn-skill', model: 'gpt-6-luna' } },
    { timestamp: '2026-10-06T16:00:01Z', ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'Jarvis could use a skill for this task.' }] } },
    { timestamp: '2026-10-06T16:00:02Z', ordinal: 2, type: 'response_item', payload: { type: 'function_call', name: 'invoke_skill', call_id: 'skill-call-1', arguments: '{"skill_name":"Jarvis"}', internal_chat_message_metadata_passthrough: { turn_id: 'turn-skill' } } },
    { timestamp: '2026-10-06T16:00:03.250Z', ordinal: 3, type: 'response_item', payload: { type: 'function_call_output', call_id: 'skill-call-1', output: 'done' } }
  ];
  const insights = api.parseLogText(records.map(JSON.stringify).join('\n'), 'skill.jsonl').insights;
  assert.equal(insights.skills.length, 1);
  assert.equal(insights.skills[0].name, 'Jarvis');
  assert.equal(insights.skills[0].count, 1);
  assert.equal(insights.skills[0].models[0], 'gpt-6-luna');
  assert.equal(insights.skills[0].invocations[0].duration_ms, 1250);
  assert.equal(insights.skills[0].invocations[0].turn_id, 'turn-skill');
});

test('reports malformed JSONL with its line number', () => {
  assert.throws(() => api.parseLogText('{\"type\":\"event\"}\nnot-json'), /line 2/i);
});

test('maps latency thresholds, formats long durations, and safely formats labels', () => {
  assert.equal(api.formatMs(999), '999ms');
  assert.equal(api.formatMs(1000), '1.00s');
  assert.equal(api.formatMs(9999), '10.0s');
  assert.equal(api.formatMs(60000), '1m 00s');
  assert.equal(api.formatMs(3600000), '1h 00m');
  assert.equal(api.formatMs(Infinity), '—');
  assert.equal(api.severity(799), 'healthy');
  assert.equal(api.severity(800), 'warning');
  assert.equal(api.severity(2001), 'critical');
  assert.equal(api.escapeHtml('<script>'), '&lt;script&gt;');
});

test('builds one HTML artifact with embedded first-party styles and scripts', () => {
  require(path.join(root, 'scripts/build.cjs'));
  const output = read('dist/index.html');
  assert.match(output, /<style>[\s\S]*body\{/);
  assert.match(output, /normalizeEvents/);
  assert.match(output, /Rollout insights/);
  assert.match(output, /First token/);
  assert.match(output, /Possible loops and repeated actions/);
  assert.match(output, /MCP calls by server and tool/);
  assert.match(output, /Individual calls/);
  assert.match(output, /Failed commands · duration and context/);
  assert.match(output, /invocation details/);
  assert.match(output, /Aggregate action counts/);
  assert.match(output, /id="eventDialog"/);
  assert.match(output, /Models &amp; orchestration/);
  assert.match(output, /id="performanceTab"/);
  assert.match(output, /role="tablist"/);
  assert.match(output, /id="eventPrevious"/);
  assert.match(output, /id="eventNext"/);
  assert.match(read('src/views.js'), /dialog\.showModal\(\)/);
  assert.match(read('src/views.js'), /function navigateEvent/);
  assert.match(output, /Inter-turn idle/);
  assert.match(output, /vis-network\.min\.js/);
  assert.match(output, /cdn\.jsdelivr\.net\/npm\/chart\.js/);
  assert.match(output, /id="themeToggle"/);
  assert.match(output, /<svg[^>]*viewBox="0 0 24 24"/);
  assert.match(output, /\.jsonl/);
  assert.match(output, /data-theme=\"light\"/);
  assert.match(output, /webkitdirectory/);
  const regularFileInput = output.match(/<input id="fileInput"[^>]*>/)[0];
  const folderInput = output.match(/<input id="folderInput"[^>]*>/)[0];
  assert.match(regularFileInput, /multiple/);
  assert.doesNotMatch(regularFileInput, /webkitdirectory/);
  assert.match(folderInput, /webkitdirectory/);
  assert.match(output, /id="mobileInput"[^>]*multiple/);
  assert.match(read('index.html'), /normalizeEvents/);
  assert.match(read('src/app.js'), /parseLogText\(reader\.result/);
  assert.match(read('src/views.js'), /renderInsights\(s\);(?:bindPerformanceTurnRows\(s\);)?renderModelAnalysis\(s\);renderTimeline/);
  assert.match(read('src/views.js'), /function bindPerformanceTurnRows/);
  assert.doesNotMatch(output, /<script[^>]+src="(?:\.\.?\/|\/)/i);
  assert.doesNotMatch(output, /<link[^>]+href="[^"]+\.css"/i);
});

test('source responsibilities stay separated into data, views, and app wiring', () => {
  assert.match(read('src/session-data.js'), /function normalizeEvents/);
  assert.match(read('src/views.js'), /function renderNetwork/);
  assert.match(read('src/app.js'), /function init/);
  assert.match(html, /INLINE_STYLES/);
  assert.match(html, /INLINE_APP/);
});
