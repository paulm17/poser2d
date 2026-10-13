import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL, isMessage, isSnapshot, isProject } from '../scene-builder/protocol.js';
import { initEditorBridge } from '../scene-builder/src/bridge.js';
const snapshot = () => ({ project: { mannequins: [], importedModels: [] }, history: ['{}'], historyIndex: 0 });
const envelope = message => ({ channel: CHANNEL, token: 'test-token', ...message });

test('bridge validates commands, references, and history bounds', () => {
  assert(isSnapshot(snapshot()));
  assert(isProject({ mannequins: [], camera: { position: [0,1,7], rotation: [0,0,0] } }), 'legacy project without imports/target is accepted');
  assert(!isProject({ mannequins: [{ position: [NaN,0,0], rotation: [0,0,0], scale: [1,1,1] }] }));
  assert(!isSnapshot({ ...snapshot(), historyIndex: 3 }));
  assert(isMessage(envelope({ type: 'restore', requestId: 'r', sessionId: 's', snapshot: snapshot() }), 'test-token'));
  assert(!isMessage(envelope({ type: 'suspend', requestId: 'r', sessionId: 's', suspended: 'yes' }), 'test-token'));
  assert(!isMessage(envelope({ type: 'connect' }), 'wrong-token'));
  assert(!isMessage(envelope({ type: 'capture', requestId: 'r', sessionId: 's', blob: new Blob(['x'], { type: 'text/plain' }) }), 'test-token'));
});

test('session bridge rejects spoofed messages, awaits restore, and binds captures to their session', async () => {
  const original = Object.fromEntries(['window', 'document', 'location', 'parent', 'crypto'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const sent = [], handlers = {}, restored = [];
  const parent = { postMessage(message) { sent.push(message); } };
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: { addEventListener(type, fn) { handlers[type] = fn; }, sceneSuspended: true } },
    document: { configurable: true, value: { body: { inert: false } } },
    location: { configurable: true, value: { search: '?bridge=test-token', origin: 'app://localhost' } },
    parent: { configurable: true, value: parent },
    crypto: { configurable: true, value: { randomUUID: () => 'capture-id' } },
  });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const deliver = (message, source = parent, origin = location.origin) => handlers.message({ source, origin, data: envelope(message) });
  let finishRestore;
  const waitingRestore = new Promise(resolve => { finishRestore = resolve; });
  const bridge = initEditorBridge({
    whenIdle: async () => {}, snapshot,
    async restore(data) { await waitingRestore; restored.push(data); },
    suspend(value) { window.sceneSuspended = value; },
  });
  try {
    assert.equal(sent.at(-1).type, 'ready', 'editor announces readiness even if connect arrived before initialization');
    const initialCount = sent.length;
    deliver({ type: 'connect' }, {}); deliver({ type: 'connect' }, parent, 'https://example.com');
    assert.equal(sent.length, initialCount);
    deliver({ type: 'connect' }); assert.equal(sent.at(-1).type, 'ready');
    deliver({ type: 'restore', requestId: 'restore-a', sessionId: 'a', snapshot: null });
    await tick(); assert(!sent.some(m => m.requestId === 'restore-a'));
    finishRestore(); await tick(); assert.equal(restored.length, 1);
    deliver({ type: 'snapshot', requestId: 'wrong-session', sessionId: 'b' }); await tick();
    assert.equal(sent.at(-1).type, 'error');
    deliver({ type: 'suspend', requestId: 'resume', sessionId: 'a', suspended: false }); await tick();
    const capture = bridge.sendCapture(async () => new Blob(['png'], { type: 'image/png' }));
    await tick(); const message = sent.find(m => m.type === 'capture'); assert.equal(message.sessionId, 'a');
    deliver({ type: 'restore', requestId: 'restore-b', sessionId: 'b', snapshot: snapshot() }); await tick();
    assert.equal(restored.length, 1, 'session restore waits for capture acknowledgement');
    deliver({ type: 'capture-result', requestId: message.requestId, sessionId: 'b' }); await tick();
    assert.equal(restored.length, 1, 'wrong-session acknowledgement is ignored');
    deliver({ type: 'capture-result', requestId: message.requestId, sessionId: 'a' });
    await capture; await tick(); assert.equal(restored.length, 2);
    deliver({ type: 'snapshot', requestId: 'snapshot-b', sessionId: 'b' }); await tick();
    assert.deepEqual(sent.at(-1).snapshot, snapshot());
    const failed = bridge.sendCapture(async () => new Blob(['png'], { type: 'image/png' })); await tick();
    deliver({ type: 'capture-result', requestId: 'capture-id', sessionId: 'b', error: 'Up to 10 reference images are allowed.' });
    await assert.rejects(failed, /10 reference/);
    assert.equal(sent.at(-1).busy, false);
  } finally {
    for (const [key, descriptor] of Object.entries(original)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  }
});
