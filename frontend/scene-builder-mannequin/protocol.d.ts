export const CHANNEL: 'qwen-stage-v1';
export type LightType = 'ambient' | 'directional' | 'hemisphere' | 'point' | 'spot' | 'area';
export type Vector3 = [number, number, number];
export interface ShadowSettings {
  resolution: 0 | 256 | 512 | 1024 | 2048 | 4096;
  bias: number; normalBias: number; near: number; far: number;
  left: number; right: number; bottom: number; top: number; radius: number; blurSamples: number;
}
interface LightBase { id: string; name: string; enabled: boolean; color: string; intensity: number }
interface ShadowLight { castShadow: boolean; autoFit: boolean; quality: 'low' | 'balanced' | 'high'; shadow: ShadowSettings }
export type LightingLight =
  | (LightBase & { type: 'ambient' })
  | (LightBase & ShadowLight & { type: 'directional'; position: Vector3; target: Vector3 })
  | (LightBase & { type: 'hemisphere'; position: Vector3; groundColor: string })
  | (LightBase & ShadowLight & { type: 'point'; position: Vector3; distance: number; decay: number })
  | (LightBase & ShadowLight & { type: 'spot'; position: Vector3; target: Vector3; distance: number; decay: number; angle: number; penumbra: number })
  | (LightBase & { type: 'area'; position: Vector3; rotation: Vector3; width: number; height: number });
export interface LightingState {
  version: 2;
  shadows: { enabled: boolean; quality: 'low' | 'balanced' | 'high'; filter: 'basic' | 'pcf' | 'pcfSoft' | 'vsm' };
  ground: { visible: boolean; receiveShadow: boolean; color: string; opacity: number; extent: number };
  lights: LightingLight[];
}
export interface LegacyLightingState {
  version: 1;
  shadows: { enabled: boolean };
  lights: Array<
    | { id: 'main'; type: 'directional'; enabled: boolean; color: string; intensity: number;
        position: Vector3; target: Vector3; castShadow: boolean; quality: 'low' | 'balanced' | 'high'; autoFit: true }
    | { id: 'ambient'; type: 'ambient'; enabled: boolean; color: string; intensity: number }
  >;
}
export interface LightingEditorState { selected: string | null; mode: 'light' | 'target' | 'rotate'; helper: boolean; frustum?: boolean }
export interface ExactMakeHumanPose {
  version: 1;
  rig: 'makehuman-ual65-v2';
  joints: Record<string, { quaternion: [number, number, number, number]; position: Vector3; scale: Vector3 }>;
}
export interface MakeHumanMannequinState {
  rig: 'makehuman-ual65-v2';
  name?: string;
  position: Vector3;
  rotation: [number, number, number, string?];
  scale: Vector3;
  exactPose: ExactMakeHumanPose;
  poseFrame?: { id: string; frame: number } | null;
  shadowSettings?: { cast?: boolean; receive?: boolean };
}
export interface MakeHumanProject {
  format: 'scene-builder-mannequin';
  version: 1;
  rig: 'makehuman-ual65-v2';
  mannequins: MakeHumanMannequinState[];
  importedModels?: unknown[];
  lighting?: LightingState;
  [key: string]: unknown;
}
export interface SceneSnapshot {
  project: { mannequins: unknown[]; importedModels: unknown[]; lighting?: LightingState | LegacyLightingState; lightingEditor?: LightingEditorState; [key: string]: unknown };
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
export function isProject(value: unknown): value is MakeHumanProject;
export function isSnapshot(value: unknown): value is SceneSnapshot;
export function isMessage(value: unknown, token: string): value is SceneMessage;
export function targetOrigin(origin: string): string;
