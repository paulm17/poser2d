export const CHANNEL: 'qwen-stage-v1';
export interface SceneSnapshot {
  project: { mannequins: unknown[]; importedModels: unknown[]; [key: string]: unknown };
  history: string[];
  historyIndex: number;
}
type Identified = { sessionId: string; requestId: string };
export type SceneMessage = { channel: typeof CHANNEL; token: string } & (
  | { type: 'connect' | 'ready' }
  | { type: 'startup-error'; error: string }
  | { type: 'busy'; busy: boolean }
  | (Identified & { type: 'snapshot' })
  | (Identified & { type: 'restore'; snapshot: SceneSnapshot | null })
  | (Identified & { type: 'suspend'; suspended: boolean })
  | (Identified & { type: 'ack'; snapshot?: SceneSnapshot })
  | (Identified & { type: 'error'; error: string })
  | (Identified & { type: 'capture'; blob: Blob })
  | (Identified & { type: 'capture-result'; error?: string })
);
export function isProject(value: unknown): boolean;
export function isSnapshot(value: unknown): value is SceneSnapshot;
export function isMessage(value: unknown, token: string): value is SceneMessage;
export function targetOrigin(origin: string): string;
