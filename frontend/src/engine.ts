import type { Settings, ReferenceImage } from "./models";
import { invoke, listen } from "./ipc";
export interface EnginePaths { pose_lora: string; pose_enabled: boolean; pose_strength: number; turbo: boolean; pe_cli: string; pe_model: string; pe_system: string; cli: string; model: string; model8: string; quant_bits: 4 | 8; vae: string; llm: string; vision: string; }
export const emptyPaths: EnginePaths = { pose_lora: "", pose_enabled: true, pose_strength: 0.7, turbo: false, pe_cli: "", pe_model: "", pe_system: "", cli: "", model: "", model8: "", quant_bits: 4, vae: "", llm: "", vision: "" };
export interface Job {
  id: string; session: string; settings: Settings; revision: number;
  state: "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
  stage: string; step: number; total: number; logs: string[];
  enhanced_prompt: string | null; error: string | null; output: string | null; width: number | null; height: number | null;
}
export interface GenerationRequest { auto_ratio: boolean; session: string; settings: Settings; references: ReferenceImage[]; paths: EnginePaths; }
// Normalize browser-only blob URLs (including scene captures and SVG demo takes)
// before crossing into Rust; vpipe receives immutable PNG files per job.
async function referencePNG(reference: ReferenceImage): Promise<{ png: string }> {
  const image = new Image(); image.src = reference.url; await image.decode();
  if (image.naturalWidth > 8192 || image.naturalHeight > 8192) throw new Error("References must be at most 8192 pixels per side.");
  const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d"); if (!context) throw new Error("Could not prepare reference image");
  context.drawImage(image, 0, 0);
  const png = canvas.toDataURL("image/png").split(",")[1];
  if (png.length > 48 * 1024 * 1024) throw new Error("Reference image exceeds 36 MB.");
  return { png };
}
export const engine = {
  async generate(request: GenerationRequest): Promise<{ id: string }> {
    const references = [];
    for (const reference of request.references) references.push(await referencePNG(reference));
    return invoke("submit_generation", { ...request, references });
  },
  ready: () => invoke("engine_subscribed"),
  cancel: (id: string) => invoke("cancel_generation", { id }),
  snapshot: () => invoke<{ jobs: Job[] }>("get_jobs"),
  defaults: () => invoke<EnginePaths>("engine_defaults"),
  listen: (handler: (job: Job) => void) => listen<Job>("engine-job", handler),
};

export function mergePaths(previous: EnginePaths, defaults: EnginePaths): EnginePaths {
  const legacy = /\.gguf$/i.test(previous.model) || /sd-cli$/.test(previous.cli);
  const merged: EnginePaths = { ...defaults, ...previous, turbo: true, quant_bits: previous.quant_bits === 8 ? 8 : 4 };
  for (const key of ["cli", "model", "model8", "vae", "llm", "pe_cli", "pe_model", "pe_system", "pose_lora"] as const) {
    if (!previous[key] || (legacy && key !== "pose_lora")) merged[key] = defaults[key];
  }
  merged.vision = "";
  return merged;
}
