import type { Settings, ReferenceImage } from "./models";
import { invoke, listen } from "./ipc";
export interface EnginePaths { pose_lora: string; pose_enabled: boolean; pose_strength: number; turbo: boolean; pe_cli: string; pe_model: string; pe_system: string; cli: string; model: string; vae: string; llm: string; vision: string; }
export const emptyPaths: EnginePaths = { pose_lora: "", pose_enabled: true, pose_strength: 0.7, turbo: false, pe_cli: "", pe_model: "", pe_system: "", cli: "", model: "", vae: "", llm: "", vision: "" };
export interface Job {
  id: string; session: string; settings: Settings; revision: number;
  state: "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
  stage: string; step: number; total: number; logs: string[];
  enhanced_prompt: string | null; error: string | null; output: string | null; width: number | null; height: number | null;
}
export interface GenerationRequest { auto_ratio: boolean; session: string; settings: Settings; references: ReferenceImage[]; paths: EnginePaths; }
// Normalize browser-only blob URLs (including scene captures and SVG demo takes)
// before crossing into Rust; sd-cli receives immutable PNG files per job.
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
  if (previous.model.split(/[\\/]/).pop() === "qwen-image-2.1-turbo-Q8_0.gguf"
    && defaults.model.split(/[\\/]/).pop() === "qwen-image-2.1-turbo-Q4_K_S.gguf") {
    previous = { ...previous, model: defaults.model };
  }
  return previous.model
    ? { ...previous, pose_lora: previous.pose_lora || defaults.pose_lora, cli: previous.cli || defaults.cli, vision: previous.vision || defaults.vision, pe_cli: previous.pe_cli || defaults.pe_cli, pe_model: previous.pe_model || defaults.pe_model, pe_system: previous.pe_system || defaults.pe_system }
    : { ...defaults, ...Object.fromEntries(Object.entries(previous).filter(([key, value]) => key !== "turbo" && value !== "")) };
}
