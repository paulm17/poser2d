export const RATIOS = {
  "1:1": [2048, 2048],
  "4:3": [2400, 1792],
  "3:4": [1792, 2400],
  "3:2": [2528, 1696],
  "2:3": [1696, 2528],
  "16:9": [2752, 1536],
  "9:16": [1536, 2752],
} as const;
export type Ratio = keyof typeof RATIOS;
export interface Settings {
  prompt: string;
  ratio: Ratio | null;
  width: number | null;
  height: number | null;
  steps: number;
  seed: number;
  enhance: boolean;
  think: boolean;
  transparent: boolean;
  device: string;
}
export interface ReferenceImage {
  id: string;
  name: string;
  url: string;
  width: number;
  height: number;
}
export interface Take {
  generated?: boolean;
  id: string;
  url: string;
  settings: Settings;
  width: number;
  height: number;
  enhancedPrompt?: string;
}
export interface Session {
  id: string;
  name: string;
  settings: Settings;
}
export const defaults: Settings = {
  prompt: "",
  ratio: null,
  width: null,
  height: null,
  steps: 40,
  seed: 42,
  enhance: false,
  think: false,
  transparent: false,
  device: "auto",
};
export function plannedSize(s: Settings, refs: ReferenceImage[]) {
  let base: readonly number[] | null = RATIOS["1:1"];
  let source = "default 1:1";
  if (s.ratio) {
    base = RATIOS[s.ratio];
    source = "chosen";
  } else if (s.enhance) {
    base = null;
    source = "picked by the enhancer";
  } else if (refs.length) {
    const last = refs[refs.length - 1];
    const r = last.width / last.height;
    const w = Math.sqrt(1024 * 1024 * r);
    base = [Math.round(w / 32) * 32, Math.round(w / r / 32) * 32];
    source = "follows the last image";
  }
  return {
    width: s.width ?? base?.[0] ?? null,
    height: s.height ?? base?.[1] ?? null,
    source,
  };
}
export function resolveMentions(prompt: string, refs: ReferenceImage[]) {
  return prompt.replace(
    /@([A-Za-z0-9._-]*[A-Za-z0-9_-])/g,
    (match, name: string) => {
      const i = refs.findIndex((r) => r.name === name);
      return i < 0 ? match : `<image${i + 1}>`;
    },
  );
}
