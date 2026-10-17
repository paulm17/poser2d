import { forwardRef, useEffect, useLayoutEffect, useImperativeHandle, useRef, useState } from 'react';
import { isMessage as isMannequinMessage } from '../scene-builder-mannequin/protocol.js';
import { CHANNEL, isMessage, targetOrigin, type SceneMessage, type SceneSnapshot } from '../scene-builder/protocol.js';

export interface StageEditorHandle {
  duplicate(from: string, to: string): Promise<void>;
  forget(session: string): void;
}
interface Props {
  sessionId: string;
  variant?: 2 | 'mannequin' | 'mannequin-2';
  visible: boolean;
  onCapture(sessionId: string, blob: Blob): Promise<void>;
  onBusy(busy: boolean): void;
}
type Command =
  | { type: 'snapshot' }
  | { type: 'restore'; snapshot: SceneSnapshot | null }
  | { type: 'suspend'; suspended: boolean };

export const StageEditor = forwardRef<StageEditorHandle, Props>(function StageEditor(props, ref) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const host = useRef<HTMLElement>(null);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight - 60 });
  const callbacks = useRef(props); callbacks.current = props;
  const token = useRef(crypto.randomUUID());
  const scenes = useRef(new Map<string, SceneSnapshot>());
  const current = useRef<string | null>(null);
  const serial = useRef(Promise.resolve());
  const pending = useRef(new Map<string, { sessionId: string; resolve(message: SceneMessage): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>());
  const [ready, setReady] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(true);
  const editorBusy = useRef(false), hostBusy = useRef(false);
  function reportBusy() { callbacks.current.onBusy(hostBusy.current || editorBusy.current); }
  function send(message: object) {
    iframe.current?.contentWindow?.postMessage({ channel: CHANNEL, token: token.current, ...message }, targetOrigin(location.origin));
  }
  function request(sessionId: string, command: Command) {
    return new Promise<SceneMessage>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { pending.current.delete(requestId); reject(Error('The scene editor did not respond. Reopen the app to retry.')); }, 60000);
      pending.current.set(requestId, { sessionId, resolve, reject, timer });
      send({ ...command, sessionId, requestId });
    });
  }
  async function saveCurrent() {
    if (!current.current) return;
    const response = await request(current.current, { type: 'snapshot' });
    if (response.type !== 'ack' || !response.snapshot) throw Error('The editor returned an invalid scene snapshot.');
    scenes.current.set(current.current, response.snapshot);
  }
  function enqueue(action: () => Promise<void>) {
    const operation = serial.current.then(async () => {
      hostBusy.current = true; setWorking(true); reportBusy();
      try { await action(); setError(''); }
      finally { hostBusy.current = false; setWorking(false); reportBusy(); }
    });
    serial.current = operation.catch(err => { setError(err instanceof Error ? err.message : String(err)); });
    return operation;
  }
  useLayoutEffect(() => {
    if (!props.visible || !host.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setViewport(previous => previous.width === width && previous.height === height ? previous : { width, height });
    });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [props.visible]);
  useImperativeHandle(ref, () => ({
    async duplicate(from, to) {
      if (!ready) return;
      await enqueue(async () => {
        await saveCurrent();
        const snapshot = scenes.current.get(from);
        if (snapshot) scenes.current.set(to, structuredClone(snapshot));
      });
    },
    forget(session) { scenes.current.delete(session); if (current.current === session) current.current = null; },
  }));
  useLayoutEffect(() => {
    const listener = async (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow || event.origin !== location.origin || !((callbacks.current.variant === 'mannequin' || callbacks.current.variant === 'mannequin-2') ? isMannequinMessage(event.data, token.current) : isMessage(event.data, token.current))) return;
      const message = event.data;
      if (message.type === 'ready') { setReady(true); return; }
      if (message.type === 'startup-error') { setError(message.error); setWorking(false); return; }
      if (message.type === 'busy') { editorBusy.current = message.busy; reportBusy(); return; }
      if (message.type === 'ack' || message.type === 'error') {
        const entry = pending.current.get(message.requestId);
        if (!entry || entry.sessionId !== message.sessionId) return;
        clearTimeout(entry.timer); pending.current.delete(message.requestId);
        message.type === 'error' ? entry.reject(Error(message.error)) : entry.resolve(message);
      } else if (message.type === 'capture') {
        let failure: string | undefined;
        try {
          if (message.sessionId !== current.current) throw Error('The scene session changed. Try the capture again.');
          await callbacks.current.onCapture(message.sessionId, message.blob);
        } catch (err) { failure = err instanceof Error ? err.message : String(err); }
        send({ type: 'capture-result', sessionId: message.sessionId, requestId: message.requestId, ...(failure ? { error: failure } : {}) });
      }
    };
    window.addEventListener('message', listener);
    send({ type: 'connect' });
    return () => {
      window.removeEventListener('message', listener);
      pending.current.forEach(entry => { clearTimeout(entry.timer); entry.reject(Error('The scene editor closed.')); }); pending.current.clear();
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    const sessionId = props.sessionId, visible = props.visible;
    void enqueue(async () => {
      if (current.current !== sessionId) {
        await saveCurrent();
        await request(sessionId, { type: 'restore', snapshot: scenes.current.get(sessionId) ?? null });
        current.current = sessionId;
      }
      await request(sessionId, { type: 'suspend', suspended: !visible });
    }).catch(() => {});
  }, [ready, loadVersion, props.sessionId, props.visible]);
  useEffect(() => {
    const retry = !ready ? setInterval(() => send({ type: 'connect' }), 500) : undefined;
    const timer = setTimeout(() => { if (!ready) { setError('The scene editor could not start. Check that WebGL is available, then reopen the app.'); setWorking(false); } }, 30000);
    return () => { clearTimeout(timer); clearInterval(retry); };
  }, [ready]);
  return (
    <main ref={host} style={props.visible ? undefined : { width: viewport.width, height: viewport.height }} className={`stage-host${props.visible ? '' : ' stage-host-hidden'}`} aria-hidden={!props.visible} inert={!props.visible || working || !!error}>
      <iframe ref={iframe} title={props.variant === 'mannequin-2' ? "MakeHuman scene 2 editor" : props.variant === 'mannequin' ? "MakeHuman scene editor" : props.variant === 2 ? "Stage scene 2 editor" : "Pose scene editor"} src={`./scene-builder${props.variant === 'mannequin-2' ? "-mannequin-2" : props.variant === 'mannequin' ? "-mannequin" : props.variant === 2 ? "-2" : ""}/index.html?bridge=${token.current}`} onLoad={() => { current.current = null; setReady(false); setLoadVersion(value => value + 1); send({ type: 'connect' }); }} />
      {(working || error) && <div className="stage-loading" role={error ? 'alert' : 'status'}>{error || 'Preparing scene…'}</div>}
    </main>
  );
});
