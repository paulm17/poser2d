interface CefQueryRequest {
  request: string;
  onSuccess: (response: string) => void;
  onFailure: (code: number, message: string) => void;
}
declare global { interface Window { cefQuery?: (request: CefQueryRequest) => number; } }
export function invoke<T>(cmd: string, args: unknown = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!window.cefQuery) { reject(new Error("Generation is available in the desktop app. Open the Rust application to connect the engine.")); return; }
    window.cefQuery({ request: JSON.stringify({ cmd, args, id: crypto.randomUUID() }),
      onSuccess: raw => { try { const response = JSON.parse(raw); if (response.success) resolve(response.data); else reject(new Error(response.error)); } catch (error) { reject(error); } },
      onFailure: (_code, message) => reject(new Error(message)),
    });
  });
}
export function listen<T>(event: string, handler: (payload: T) => void): () => void {
  const listener = (raw: Event) => {
    const detail = (raw as CustomEvent<{ event: string; payload: T }>).detail;
    if (detail?.event === event) handler(detail.payload);
  };
  window.addEventListener("rust-cef-event", listener);
  return () => window.removeEventListener("rust-cef-event", listener);
}
