const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src/session-data.js'), 'utf8');
const sandbox = { Date, Math, JSON, Number, String, Array, Object, RegExp, globalThis: {} };
vm.runInNewContext(source, sandbox);
const api = sandbox.globalThis.CodexPulse;

test('calculates user message waits in event time order and exposes session aggregates', () => {
  const session = api.normalizeSession({ events: [
    { id: 'user-2', type: 'user', start: 5000, duration_ms: 100 },
    { id: 'assistant', type: 'assistant', start: 1000, duration_ms: 1000 },
    { id: 'user-1', type: 'user', start: 0, duration_ms: 500 },
    { id: 'tool', type: 'tool', start: 4000, duration_ms: 2500 },
    { id: 'user-3', type: 'user', start: 7000, duration_ms: 50 },
    { id: 'user-4', type: 'user', start: 8000, duration_ms: 50 }
  ] });

  assert.equal(session.total, 8050);
  assert.deepEqual({ ...session.insights.userInteraction }, {
    userMessageCount: 4,
    measurableCount: 3,
    totalWaitMs: 2850,
    average_ms: 950,
    p50_ms: 950,
    p95_ms: 1900,
    max_ms: 1900,
    session_duration_ms: 8050,
    sessionPercent: 2850 / 8050 * 100
  });

  const byId = Object.fromEntries(session.events.map((event) => [event.id, event]));
  assert.equal(byId['user-1'].userWaitMs, null);
  assert.equal(byId['user-2'].userWaitMs, 0); // Its chronological predecessor overlaps it.
  assert.equal(byId['user-3'].userWaitMs, 1900);
  assert.equal(byId['user-3'].userInteractionAnalysis.previous_event_id, 'user-2');
  assert.equal(byId['user-4'].userWaitMs, 950);
});

test('supports rollout JSONL user messages and preserves existing session insights', () => {
  const records = [
    { timestamp: '2026-10-13T00:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { session_id: 'rollout-session' } },
    { timestamp: '2026-10-13T00:00:01.000Z', ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'first prompt' }] } },
    { timestamp: '2026-10-13T00:00:03.000Z', ordinal: 2, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'response' }] } },
    { timestamp: '2026-10-13T00:00:08.000Z', ordinal: 3, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'follow up' }] } },
    { timestamp: '2026-10-13T00:00:13.000Z', ordinal: 4, type: 'token_usage_record', payload: { usage: { input_tokens: 12 } } }
  ];
  const parsed = api.parseLogText(records.map(JSON.stringify).join('\n'));
  parsed.insights.marker = 'kept';
  const session = api.normalizeSession(parsed);

  assert.equal(session.insights.marker, 'kept');
  assert.equal(session.insights.userInteraction.userMessageCount, 2);
  assert.equal(session.insights.userInteraction.measurableCount, 1);
  assert.equal(session.insights.userInteraction.totalWaitMs, 5000);
  assert.equal(session.total, 13000); // The session extent includes the final recorded rollout item.
  assert.equal(session.insights.userInteraction.sessionPercent, 5000 / 13000 * 100);
  assert.equal(session.events.find((event) => event.name === 'User message').userWaitMs, null);
  assert.equal(session.events.find((event) => event.input === 'follow up').userWaitMs, 5000);
});

test('does not treat an inferred generic event duration as observed work time', () => {
  const session = api.normalizeSession({ events: [
    { id: 'assistant', type: 'assistant', timestamp: '2026-10-13T00:00:00.000Z' },
    { id: 'user', type: 'user', timestamp: '2026-10-13T00:00:07.000Z' }
  ] });

  assert.equal(session.events.find((event) => event.id === 'assistant').durationRecorded, false);
  assert.equal(session.events.find((event) => event.id === 'user').userWaitMs, 7000);
  assert.equal(session.insights.userInteraction.userMessageCount, 1);
  assert.equal(session.insights.userInteraction.totalWaitMs, 7000);
});

test('leaves intervals without source timestamps unmeasurable', () => {
  const session = api.normalizeSession({ events: [
    { id: 'assistant', type: 'assistant', duration_ms: 900 },
    { id: 'user', type: 'user', message: 'Continue' }
  ] });

  assert.equal(session.userInteraction.userMessageCount, 1);
  assert.equal(session.userInteraction.measurableCount, 0);
  assert.equal(session.events.find((event) => event.id === 'user').userWaitMs, null);
});
