const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const script = ['src/session-data.js', 'src/views.js', 'src/app.js']
  .map((file) => fs.readFileSync(path.join(root, file), 'utf8'))
  .join('\n');
const sandbox = { Date, Math, JSON, Number, String, Array, Object, RegExp, Intl, globalThis: {}, document: undefined };
vm.runInNewContext(script, sandbox);
const api = sandbox.globalThis.CodexPulse;

const rollout = (records) => api.parseLogText(records.map(JSON.stringify).join('\n'), 'actions.jsonl');

test('provides individual failed command and MCP call details with durations and event links', () => {
  const records = [
    { timestamp: '2026-10-10T12:00:00Z', ordinal: 3, type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-a', started_at_ms: 1791633600000, completed_at_ms: 1791633602450, item: { type: 'CommandExecution', status: 'failed', exit_code: 2, command: 'dotnet test' } } },
    { timestamp: '2026-10-10T12:00:04Z', ordinal: 4, type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-a', started_at_ms: 1791633603000, completed_at_ms: 1791633603300, item: { type: 'McpToolCall', server: 'docs', tool: 'search', status: 'completed', id: 'mcp-call-1' } } }
  ];
  const session = api.normalizeSession(rollout(records));
  assert.equal(session.insights.commandFailures.length, 1);
  assert.equal(session.insights.commandFailures[0].duration_ms, 2450);
  assert.equal(session.insights.commandFailures[0].event_id, 'action-3');
  assert.equal(session.insights.commandFailures[0].exit_code, 2);
  assert.equal(session.insights.mcpCallDetails.length, 1);
  assert.equal(session.insights.mcpCallDetails[0].duration_ms, 300);
  assert.equal(session.insights.mcpCallDetails[0].event_id, 'mcp-4');
  assert.equal(session.insights.mcpCallDetails[0].call_id, 'mcp-call-1');
});

test('keeps unavailable durations explicit and excludes successful commands from failure list', () => {
  const records = [
    { timestamp: '2026-10-10T12:00:00Z', ordinal: 1, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', status: 'completed', command: 'pwd' } } },
    { timestamp: '2026-10-10T12:00:01Z', ordinal: 2, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'calendar', tool: 'list', status: 'completed' } } }
  ];
  const insights = rollout(records).insights;
  assert.equal(insights.commandFailures.length, 0);
  assert.equal(insights.mcpCallDetails[0].duration_ms, null);
  assert.equal(insights.mcpCallDetails[0].turn_id, '');
});
