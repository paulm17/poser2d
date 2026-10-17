import { CHANNEL, isMessage, targetOrigin } from '../protocol.js';

export function initEditorBridge(editor) {
  const token = new URLSearchParams(location.search).get('bridge');
  let sessionId = null, capturePending = null, serial = Promise.resolve();
  const send = message => parent.postMessage({ channel: CHANNEL, token, ...message }, targetOrigin(location.origin));
  if(!token){editor.suspend(false);return {busy(){},sendCapture(){return Promise.reject(Error('Open this editor from Studio to send a capture.'));}};}
  editor.suspend(true);
  document.body.inert = true;
  window.addEventListener('message', event => {
    if (event.source !== parent || event.origin !== location.origin || !isMessage(event.data, token)) return;
    const message = event.data;
    if (message.type === 'connect') { send({ type: 'ready' }); return; }
    if (message.type === 'capture-result') {
      if (capturePending?.requestId === message.requestId && capturePending.sessionId === message.sessionId) {
        message.error ? capturePending.reject(Error(message.error)) : capturePending.resolve();
      }
      return;
    }
    if (!['snapshot', 'restore', 'suspend'].includes(message.type)) return;
    serial = serial.then(async () => {
      const reply = { requestId: message.requestId, sessionId: message.sessionId };
      document.body.inert = true;
      try {
        await editor.whenIdle();
        if (capturePending) await capturePending.done;
        if (message.type !== 'restore' && sessionId !== message.sessionId) throw Error('The scene session changed.');
        if (message.type === 'restore') {
          editor.suspend(true); await editor.restore(message.snapshot); sessionId = message.sessionId;
        } else if (message.type === 'suspend') editor.suspend(message.suspended);
        send({ type: 'ack', ...reply, ...(message.type === 'snapshot' ? { snapshot: editor.snapshot() } : {}) });
      } catch (error) { send({ type: 'error', ...reply, error: error.message || String(error) }); }
      finally { document.body.inert = !sessionId || !!window.sceneSuspended; }
    });
  });
  window.sceneBridgeReady = true;
  send({ type: 'ready' });
  return {
    busy: busy => send({ type: 'busy', busy }),
    async sendCapture(capture) {
      if (!sessionId || capturePending) throw Error('Wait for the scene to be ready.');
      const capturedSession = sessionId, requestId = crypto.randomUUID();
      document.body.inert = true; send({ type: 'busy', busy: true });
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      try {
        // Reserve the capture before awaiting encoding, preventing session restores.
        let resolve, reject;
        const result = new Promise((yes, no) => { resolve = yes; reject = no; });
        capturePending = { sessionId: capturedSession, requestId, resolve, reject, done };
        const blob = await capture();
        send({ type: 'capture', sessionId: capturedSession, requestId, blob });
        const timer = setTimeout(() => reject(Error('Studio did not accept the capture. Try again.')), 30000);
        try { await result; } finally { clearTimeout(timer); }
      } finally {
        capturePending = null; finish(); document.body.inert = !!window.sceneSuspended; send({ type: 'busy', busy: false });
      }
    },
  };
}
