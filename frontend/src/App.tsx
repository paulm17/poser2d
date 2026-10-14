import { SplatViewer } from './SplatViewer';
import { splatAction } from './splat-action';
import { generationAction } from './generation-action';
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  defaults,
  plannedSize,
  RATIOS,
  resolveMentions,
  type Settings,
  type Session,
  type ReferenceImage,
  type Take,
  type Ratio,
} from "./models";
import { effectiveGuidance, engine, emptyPaths, mergePaths, initialModelId, selectModelPaths, unavailableCatalog, type EnginePaths, type Job, type AdapterSelection, type CatalogModel } from "./engine";
import { StageEditor, type StageEditorHandle } from "./StageEditor";

function Dialog({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? "gallery-dialog" : ""}
      onCancel={onClose}
      aria-label={title}
    >
      <div className="gallery-head">
        <h3>{title}</h3>
        <span className="spacer" />
        <button className="btn sm" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="gallery-grid">{children}</div>
    </dialog>
  );
}
function Toggle({
  title,
  description,
  checked,
  onChange,
  disabled = false,
  sub = false,
  tag,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  sub?: boolean;
  tag?: string;
}) {
  return (
    <label
      className={`toggle${sub ? " sub" : ""}${disabled ? " disabled" : ""}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <b>
        {title}
        {tag && <span className="tag">{tag}</span>}
      </b>
      <em>{description}</em>
    </label>
  );
}
function initialSessions(): Session[] {
  try {
    const stored = JSON.parse(
      localStorage.getItem("qwen-ui-sessions") ?? "null",
    );
    if (
      Array.isArray(stored) &&
      stored.length &&
      stored.every(
        (s) =>
          typeof s.id === "string" &&
          typeof s.name === "string" &&
          s.settings &&
          typeof s.settings.prompt === "string",
      )
    )
      return stored.map((s) => ({
        ...s,
        settings: { ...defaults, ...s.settings, device: "mps" },
      }));
  } catch {
    /* Start fresh if browser storage is unavailable. */
  }
  return [{ id: "default", name: "Default", settings: { ...defaults } }];
}
const stages = ["Enhance", "Load", "Denoise", "Decode", "Save"];
export function App() {
  const [sessions, setSessions] = useState(initialSessions);
  const [active, setActive] = useState(() => sessions[0].id);
  const current = sessions.find((s) => s.id === active)!;
  const settings = current.settings;
  const [images, setImages] = useState<Record<string, ReferenceImage[]>>({});
  const imagesRef = useRef(images); imagesRef.current = images;
  const sessionsRef = useRef(sessions); sessionsRef.current = sessions;
  const ingestion = useRef(Promise.resolve());
  const refs = images[active] ?? [];
  const [takes, setTakes] = useState<Record<string, Take[]>>({});
  const sessionTakes = takes[active] ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const take = sessionTakes.find((t) => t.id === selected);
  const [previewMode, setPreviewMode] = useState<"image" | "splat">("image");
  const [splatSubmitting, setSplatSubmitting] = useState<ReadonlySet<string>>(new Set());
  const splatSubmittingRef = useRef(new Set<string>());
  useEffect(() => setPreviewMode("image"), [active, selected]);
  const [view, setView] = useState<"studio" | "stage">("studio");
  const stageRef = useRef<StageEditorHandle>(null);
  const [stageOpened, setStageOpened] = useState(false);
  const [stageBusy, setStageBusy] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const controlsBusy = stageBusy || sessionBusy;
  const [dialog, setDialog] = useState<
    "gallery" | "new" | "duplicate" | "delete" | null
  >(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [paths, setPaths] = useState<EnginePaths>(() => {
    try { return { ...emptyPaths, ...JSON.parse(localStorage.getItem("qwen-engine-paths") ?? "{}") }; }
    catch { return { ...emptyPaths }; }
  });
  const [jobs, setJobs] = useState<Job[]>([]);
  const submittingRef = useRef(new Set<string>());
  const [submittingSessions, setSubmittingSessions] = useState<ReadonlySet<string>>(new Set());
  const cancellingRef = useRef(new Set<string>());
  const [pendingCancellations, setPendingCancellations] = useState<ReadonlySet<string>>(new Set());
  const action = generationAction(jobs.filter(j => j.kind !== "splat"), active, submittingSessions.has(active), pendingCancellations);
  const [engineConnected, setEngineConnected] = useState(false);
  const completedJobs = useRef(new Set<string>());
  const failedJobs = useRef(new Set<string>());
  const activeRef = useRef(active); activeRef.current = active;
  const currentJob = jobs.find(j => j.kind !== "splat" && j.session === active && (j.state === "running" || j.state === "cancelling"));
  const splat = splatAction(jobs, take?.id, !!take && splatSubmitting.has(take.id));
  const splatJob = splat.job;
  async function generateSplat() {
    if (!take || splatSubmittingRef.current.has(take.id)) return;
    const source = take.id;
    splatSubmittingRef.current.add(source);
    setSplatSubmitting(new Set(splatSubmittingRef.current));
    setError("");
    try { await engine.splat(source); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { splatSubmittingRef.current.delete(source); setSplatSubmitting(new Set(splatSubmittingRef.current)); }
  }
  useEffect(() => { localStorage.setItem("qwen-engine-paths", JSON.stringify(paths)); }, [paths]);
  useEffect(() => {
    let disposed = false;
    function accept(job: Job) {
      if (disposed) return;
      setJobs(previous => {
        const old = previous.find(j => j.id === job.id);
        if (old && old.revision > job.revision) return previous;
        return old ? previous.map(j => j.id === job.id ? job : j) : [...previous, job];
      });
      if (job.state === "failed" && !failedJobs.current.has(job.id)) {
        failedJobs.current.add(job.id);
        if (activeRef.current === job.session) setError(job.error ?? "Render failed. See render log.");
      }
      if (job.kind !== "splat" && job.state === "completed" && job.output && job.width && job.height && !completedJobs.current.has(job.id)) {
        completedJobs.current.add(job.id);
        if (sessionsRef.current.some(s => s.id === job.session)) {
          const take: Take = { id: job.id, url: job.output, settings: job.settings, width: job.width, height: job.height, enhancedPrompt: job.enhanced_prompt ?? undefined, generated: true };
          setTakes(previous => ({ ...previous, [job.session]: [...(previous[job.session] ?? []).filter(t => t.id !== job.id), take] }));
          if (activeRef.current === job.session) setSelected(job.id);
        }
      }
    }
    const unsubscribe = engine.listen(accept);
    engine.ready().then(() => engine.snapshot()).then(snapshot => { if (!disposed) { snapshot.jobs.forEach(accept); setEngineConnected(true); } }).catch(() => {});
    engine.defaults().then(defaults => { if (!disposed) setPaths(previous => mergePaths(previous, defaults)); }).catch(() => {});
    return () => { disposed = true; unsubscribe(); };
  }, []);
  const [catalog, setCatalog] = useState<CatalogModel[]>(unavailableCatalog);
  const [modelId, setModelId] = useState(() => initialModelId(localStorage.getItem("qwen-model-id"), paths.quant_bits));
  const [modelOpen, setModelOpen] = useState(false);
  const modelPopover = useRef<HTMLDivElement>(null);
  const selectedModel = catalog.find(m => m.id === modelId);
  const isTurbo = modelId.startsWith("turbo");
  const [loras, setLoras] = useState<AdapterSelection[]>(() => {
    try { const saved = JSON.parse(localStorage.getItem("qwen-loras") ?? "null"); if (Array.isArray(saved)) return saved.filter(a => (a.id === "pose" || a.id === "lightning" || a.id === "anyangle") && Number.isFinite(a.strength)); } catch {}
    return [...(paths.pose_enabled ? [{id:"pose" as const, strength:paths.pose_strength}] : []), ...(!isTurbo && paths.lightning_enabled ? [{id:"lightning" as const,strength:1}] : [])];
  });
  const lightningActive = !isTurbo && loras.some(a => a.id === "lightning");
  const anyangleActive = loras.some(a => a.id === "anyangle");
  const effectiveCfg = effectiveGuidance(settings.cfg, loras);
  const adapterAvailable = (id: AdapterSelection["id"]) => id === "pose" ? selectedModel?.pose_available : id === "anyangle" ? selectedModel?.anyangle_available : selectedModel?.lightning_available;
  const effectiveSteps = isTurbo ? 8 : lightningActive ? 4 : settings.steps;
  useEffect(() => { localStorage.setItem("qwen-loras", JSON.stringify(loras)); }, [loras]);
  useEffect(() => { engine.catalog().then(setCatalog).catch(() => {}); }, []);
  useEffect(() => { localStorage.setItem("qwen-model-id", modelId); }, [modelId]);
  useEffect(() => {
    if (!modelOpen) return;
    const close = (e: PointerEvent) => { if (!modelPopover.current?.contains(e.target as Node)) setModelOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { setModelOpen(false); modelPopover.current?.querySelector("button")?.focus(); } };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [modelOpen]);
  function selectModel(id: string) {
    setModelId(id);
    if (id.startsWith("turbo")) setLoras(a => a.filter(a => a.id !== "lightning"));
    setPaths(p => selectModelPaths(p, id));
  }
  const [logs, setLogs] = useState<string[]>([
    "[studio] Ready. Select a model to generate.",
  ]);
  const [tab, setTab] = useState<"output" | "render">("output");
  const [expanded, setExpanded] = useState(false);
  const [drag, setDrag] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const urls = useRef(new Set<string>());
  useEffect(() => {
    try {
      localStorage.setItem("qwen-ui-sessions", JSON.stringify(sessions));
    } catch {
      /* State still works in memory. */
    }
  }, [sessions]);
  useEffect(
    () => () => {
      urls.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );
  useEffect(() => {
    const used = new Set([
      ...Object.values(images).flat().map(image => image.url),
      ...Object.values(takes).flat().map(take => take.url),
    ]);
    for (const url of urls.current) if (!used.has(url)) { URL.revokeObjectURL(url); urls.current.delete(url); }
  }, [images, takes]);
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSessions((prev) =>
      prev.map((s) =>
        s.id === active
          ? { ...s, settings: { ...s.settings, [key]: value } }
          : s,
      ),
    );
  const size = plannedSize(settings, refs);
  const gridOK =
    (!size.width || size.width % 32 === 0) &&
    (!size.height || size.height % 32 === 0);
  const mentionItems = refs.filter((r) =>
    r.name.toLowerCase().startsWith((mentionQuery ?? "").toLowerCase()),
  );
  function insertMention(image: ReferenceImage, replace = false) {
    const node = promptRef.current;
    const start = node?.selectionStart ?? settings.prompt.length;
    const end = node?.selectionEnd ?? start;
    const from = replace ? start - (mentionQuery?.length ?? 0) - 1 : start;
    const text = `@${image.name} `;
    update(
      "prompt",
      settings.prompt.slice(0, from) + text + settings.prompt.slice(end),
    );
    setMentionQuery(null);
    requestAnimationFrame(() => {
      node?.focus();
      node?.setSelectionRange(from + text.length, from + text.length);
    });
  }
  function upload(files: File[], session = active): Promise<{ count: number; error: string }> {
    let result = { count: 0, error: '' };
    const operation = ingestion.current.then(async () => {
      const accepted: ReferenceImage[] = [];
      let message = '';
      for (const file of files) {
        if ((imagesRef.current[session]?.length ?? 0) + accepted.length >= 10) {
          message = 'Up to 10 reference images are allowed.'; break;
        }
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { message = 'Choose PNG, JPEG, or WebP images.'; continue; }
        const url = URL.createObjectURL(file);
        try {
          const img = new Image(); img.src = url; await img.decode();
          if ((imagesRef.current[session]?.length ?? 0) + accepted.length >= 10) { URL.revokeObjectURL(url); message = 'Up to 10 reference images are allowed.'; break; }
          const base = file.name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+|[.-]+$/g, '') || 'image';
          let name = base, suffix = 2;
          while ([...(imagesRef.current[session] ?? []), ...accepted].some(r => r.name === name)) name = `${base}-${suffix++}`;
          accepted.push({ id: crypto.randomUUID(), name, url, width: img.naturalWidth, height: img.naturalHeight });
        } catch { URL.revokeObjectURL(url); message = `Could not read ${file.name}.`; }
      }
      if (!sessionsRef.current.some(s => s.id === session)) {
        accepted.forEach(r => URL.revokeObjectURL(r.url)); message = 'The destination session was deleted.';
      } else {
        accepted.forEach(r => urls.current.add(r.url));
        imagesRef.current = { ...imagesRef.current, [session]: [...(imagesRef.current[session] ?? []), ...accepted] };
        setImages(imagesRef.current); result.count = accepted.length;
      }
      result.error = message; setError(message);
    });
    ingestion.current = operation.catch(() => {});
    return operation.then(() => result);
  }
  async function receiveScene(session: string, blob: Blob) {
    const result = await upload([new File([blob], 'scene.png', { type: 'image/png' })], session);
    if (!result.count) throw Error(result.error || 'Could not add the scene reference.');
    setView('studio');
  }
  function openDialog(value: typeof dialog) {
    setDialogError("");
    setName(value === "duplicate" ? `${current.name} copy` : "");
    setDialog(value);
  }
  async function saveSession() {
    if (controlsBusy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setDialogError("Enter a session name.");
      return;
    }
    if (sessions.some((s) => s.name === trimmed)) {
      setDialogError("That session already exists.");
      return;
    }
    const id = crypto.randomUUID();
    setSessionBusy(true);
    try {
      if (dialog === 'duplicate') await stageRef.current?.duplicate(active, id);
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : String(err)); setSessionBusy(false); return;
    }
    setSessionBusy(false);
    setSessions((prev) => [
      ...prev,
      {
        id,
        name: trimmed,
        settings: dialog === "duplicate" ? { ...settings } : { ...defaults },
      },
    ]);
    if (dialog === "duplicate")
      setImages((prev) => ({
        ...prev,
        [id]: refs.map((r) => ({ ...r, id: crypto.randomUUID() })),
      }));
    setActive(id);
    setSelected(null);
    setDialog(null);
    setError("");
  }
  function deleteSession() {
    if (controlsBusy) return;
    stageRef.current?.forget(active);
    setImages(prev => { const next = { ...prev }; delete next[active]; return next; });
    setTakes(prev => { const next = { ...prev }; delete next[active]; return next; });
    const remaining = sessions.filter((s) => s.id !== active);
    setSessions(remaining);
    setActive(remaining[0].id);
    setSelected(null);
    setDialog(null);
    setError("");
  }
  async function refreshJobs() {
    const snapshot = await engine.snapshot();
    setJobs(previous => {
      const merged = new Map(previous.map(job => [job.id, job]));
      for (const job of snapshot.jobs) if ((merged.get(job.id)?.revision ?? -1) <= job.revision) merged.set(job.id, job);
      return [...merged.values()];
    });
  }
  async function cancelGeneration(job: Job) {
    if (cancellingRef.current.has(job.id) || job.state === 'cancelling') return;
    cancellingRef.current.add(job.id);
    setPendingCancellations(new Set(cancellingRef.current));
    setError("");
    try {
      await engine.cancel(job.id);
      await refreshJobs();
    } catch (err) {
      if (activeRef.current === job.session) setError(err instanceof Error ? err.message : String(err));
    } finally {
      cancellingRef.current.delete(job.id);
      setPendingCancellations(new Set(cancellingRef.current));
    }
  }
  async function generate() {
    if (submittingRef.current.has(active) || action.job) return;
    setError("");
    if (!settings.prompt.trim()) {
      setError("Write a prompt first.");
      return;
    }
    if (
      !gridOK ||
      [settings.width, settings.height].some(
        (n) => n !== null && (!Number.isInteger(n) || n < 256 || n > 4096),
      )
    ) {
      setError("Dimensions must be multiples of 32 between 256 and 4096.");
      return;
    }
    if (
      !Number.isInteger(settings.steps) ||
      settings.steps < 1 ||
      settings.steps > 200 ||
      !Number.isSafeInteger(settings.seed) ||
      settings.seed < 0
    ) {
      setError("Use 1–200 steps and a non-negative integer seed.");
      return;
    }
    if (!Number.isFinite(effectiveCfg) || effectiveCfg < 1 || effectiveCfg > 10) {
      setError("CFG must be between 1 and 10.");
      return;
    }
    const session = active;
    submittingRef.current.add(session);
    setSubmittingSessions(new Set(submittingRef.current));
    try {
      const size = plannedSize({ ...settings, enhance: false }, refs);
      const result = await engine.generate({
        session: active,
        auto_ratio: !settings.ratio && settings.width === null && settings.height === null,
        model_id: modelId,
        loras,
        settings: {
          ...settings,
          enhance: settings.enhance, think: settings.think && settings.enhance,
          steps: effectiveSteps,
          cfg: effectiveCfg,
          width: size.width, height: size.height,
          prompt: resolveMentions(settings.prompt, refs),
        },
        references: refs,
      });
      setLogs(previous => [...previous, `[studio] Queued render ${result.id.slice(0, 8)}.`]);
      await refreshJobs();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (activeRef.current === session) setError(message);
      setLogs((prev) => [...prev, `[studio] ${message}`]);
    } finally {
      submittingRef.current.delete(session);
      setSubmittingSessions(new Set(submittingRef.current));
    }
  }
  function loadDemo() {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><defs><radialGradient id="g"><stop stop-color="#234e52"/><stop offset="1" stop-color="#111c26"/></radialGradient></defs><rect width="1024" height="1024" fill="url(#g)"/><rect x="180" y="370" width="664" height="280" rx="18" fill="#14282c" stroke="#59c8bc" stroke-width="8"/><text x="512" y="545" text-anchor="middle" font-family="sans-serif" font-size="120" fill="#9cf9e6">QWEN</text><text x="512" y="720" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#9cafb6">UI DEMO · NOT GENERATED</text></svg>';
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    urls.current.add(url);
    const id = crypto.randomUUID();
    setTakes((prev) => ({
      ...prev,
      [active]: [
        ...sessionTakes,
        {
          id,
          url,
          settings: {
            ...defaults,
            prompt: "A neon shop sign that reads QWEN",
            enhance: true,
          },
          width: 1024,
          height: 1024,
          enhancedPrompt:
            "A glowing teal neon shop sign reading QWEN, framed against a dark storefront.",
        },
      ],
    }));
    setSelected(id);
    setLogs((prev) => [...prev, "[demo] Loaded a sample take for UI review."]);
  }
  function useReference() {
    if (!take) return;
    if (refs.length >= 10) {
      setError("Up to 10 reference images are allowed.");
      return;
    }
    setImages((prev) => ({
      ...prev,
      [active]: [
        ...refs,
        {
          id: crypto.randomUUID(),
          name: `take-${take.id.slice(0, 8)}`,
          url: take.url,
          width: take.width,
          height: take.height,
        },
      ],
    }));
  }
  const numberField = (
    key: "width" | "height" | "steps" | "seed",
    label: string,
    min: number,
    max?: number,
  ) => (
    <label>
      <span className="label">{label}</span>
      <input
        type="number"
        aria-label={label}
        value={key === "steps" ? effectiveSteps : settings[key] ?? ""}
        disabled={key === "steps" && (isTurbo || lightningActive)}
        min={min}
        max={max}
        step={key === "width" || key === "height" ? 32 : 1}
        placeholder="auto"
        onChange={(e) =>
          update(
            key,
            e.target.value === ""
              ? key === "steps"
                ? 40
                : key === "seed"
                  ? 42
                  : null
              : Number(e.target.value),
          )
        }
      />
    </label>
  );
  const takeCards = (
    <div className="takes">
      {sessionTakes.length ? (
        sessionTakes.map((t) => (
          <button
            className={`take${selected === t.id ? " on" : ""}`}
            key={t.id}
            onClick={() => setSelected(t.id)}
          >
            <span className="thumb">
              <img src={t.url} alt={t.settings.prompt} />
              <span className="flags">
                <b>{t.generated ? "TAKE" : "DEMO"}</b>
              </span>
            </span>
            <span className="meta">
              {t.width} × {t.height} · {t.settings.seed}
              <span>{t.settings.prompt}</span>
            </span>
          </button>
        ))
      ) : (
        <span className="none">No takes yet</span>
      )}
    </div>
  );
  return (
    <div id="app">
      <header className="topbar">
        <div className="brand">
          qwen image <span>{view === "stage" ? "stage" : "studio"}</span>
        </div>
        <div className="row">
          <select
            aria-label="Session"
            disabled={controlsBusy}
            value={active}
            onChange={(e) => {
              setActive(e.target.value);
              setSelected(null);
              setError("");
              setMentionQuery(null);
            }}
          >
            {sessions.map((s) => (
              <option value={s.id} key={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button className="btn" disabled={controlsBusy} onClick={() => openDialog("new")}>
            + New
          </button>
          <button className="btn" disabled={controlsBusy} onClick={() => openDialog("duplicate")}>
            ⧉ Duplicate
          </button>
          <button
            className="btn danger-text"
            disabled={sessions.length === 1 || controlsBusy}
            onClick={() => openDialog("delete")}
          >
            Delete
          </button>
        </div>
        <div className="row">
          <button
            className="btn stage-switch"
            disabled={controlsBusy}
            onClick={() => { setStageOpened(true); setView(view === "studio" ? "stage" : "studio"); }}
          >
            {view === "studio" ? "Stage scene" : "Back to studio"}
          </button>
          {view === "studio" && (
            <>
              <button className="btn" onClick={() => openDialog("gallery")}>
                Gallery
              </button>

            </>
          )}
        </div>
        <div className="status">
          <span className="dot" />
          <span>{engineConnected ? "Engine connected" : "Browser preview"}</span>
        </div>
      </header>
      {stageOpened && <StageEditor ref={stageRef} sessionId={active} visible={view === 'stage'} onCapture={receiveScene} onBusy={setStageBusy} />}
      {view === 'studio' && (
        <div className="layout">
          <aside className="panel parameters" aria-label="Parameters">
            <div className="parameters-scroll">
            <section>
              <div className="label">Model</div>
              <div className="model-picker" ref={modelPopover}>
                <button className="model model-trigger" aria-expanded={modelOpen} aria-controls="model-options" onClick={() => { setModelOpen(!modelOpen); if (!modelOpen) engine.catalog().then(setCatalog).catch(() => {}); }}>
                  <span className="glyph">2.1</span><span><b>Qwen-Image-2.1</b><small>{isTurbo ? "Turbo" : "Non-Turbo"} · {modelId.endsWith("8") ? 8 : 4}-bit{lightningActive ? " · Lightning" : ""}{loras.some(a => a.id === "pose") ? " · Pose" : ""}</small></span><span>▾</span>
                </button>
                {modelOpen && <div id="model-options" className="model-popover" role="dialog" aria-label="Model selection">
                  <label>Model<select value={isTurbo ? "turbo" : "base"} onChange={e => {
                    const candidates = catalog.filter(m => m.id.startsWith(e.target.value) && m.available);
                    const candidate = candidates.find(m => m.bits === (modelId.endsWith("8") ? 8 : 4)) ?? candidates[0];
                    if (candidate) selectModel(candidate.id);
                  }}>{["base", "turbo"].map(v => <option key={v} value={v} disabled={!catalog.some(m => m.id.startsWith(v) && m.available)}>{v === "base" ? "Non-Turbo" : "Turbo"}{!catalog.some(m => m.id.startsWith(v) && m.available) ? " · Not installed" : ""}</option>)}</select></label>
                  <label>Precision<select value={modelId} onChange={e => selectModel(e.target.value)}>{catalog.filter(m => m.turbo === isTurbo).map(m => <option key={m.id} value={m.id} disabled={!m.available}>{m.bits}-bit{!m.available ? " · Not installed" : ""}</option>)}</select></label>
                </div>}
              </div>
              <div className="device-row">
                <label className="label" htmlFor="device">
                  Device
                </label>
                <select
                  id="device"
                  value={settings.device}
                  onChange={(e) => update("device", e.target.value)}
                >
                  <option value="auto">Auto — Apple Silicon Metal</option>
                  <option value="mps">Metal (Apple Silicon)</option>

                </select>
              </div>
            </section>
            <section>
              <div className="label">LoRAs</div>
              {loras.map((adapter, index) => <div className="lora-row" key={adapter.id}>
                <div className="lora-heading"><label>LoRA model<select value={adapter.id} onChange={e => setLoras(a => a.map((item, i) => i === index ? {id:e.target.value as AdapterSelection["id"], strength:e.target.value === "pose" ? 0.7 : 1} : item))}>
                  {(["lightning","pose","anyangle"] as const).filter(id => id !== "lightning" || !isTurbo).map(id => <option key={id} value={id} disabled={!adapterAvailable(id) || loras.some((a,i) => i !== index && a.id === id)}>{id === "pose" ? "Pose" : id === "anyangle" ? "AnyAngle" : "Lightning · 4 steps"}{!adapterAvailable(id) ? " · Not installed" : ""}</option>)}
                </select></label><button className="btn" aria-label={`Remove ${adapter.id} LoRA`} onClick={() => setLoras(a => a.filter((_,i) => i !== index))}>×</button></div>
                <label>LoRA strength<input type="number" min="0" max="2" step="0.1" value={adapter.strength} onChange={e => setLoras(a => a.map((item,i) => i === index ? {...item,strength:Number(e.target.value)} : item))}/></label>
              </div>)}
              <button className="btn" disabled={!(["lightning","pose","anyangle"] as const).some(id => (id !== "lightning" || !isTurbo) && adapterAvailable(id) && !loras.some(a => a.id === id))} onClick={() => {
                const id = (["lightning","pose","anyangle"] as const).find(id => (id !== "lightning" || !isTurbo) && adapterAvailable(id) && !loras.some(a => a.id === id));
                if (id) setLoras(a => [...a,{id,strength:id === "pose" ? 0.7 : 1}]);
              }}>＋ Add LoRA</button>
              <p className="hint">Stack adapters here. Pose applies to image edits.</p>
            </section>
            <section>
              <div className="label">
                Mode{" "}
                <span className="right muted">set by reference images</span>
              </div>
              <div className="mode">
                <span className={!refs.length ? "on" : ""}>Text → image</span>
                <span className={refs.length ? "on" : ""}>
                  Edit
                  {refs.length
                    ? ` · ${refs.length} image${refs.length > 1 ? "s" : ""}`
                    : ""}
                </span>
              </div>
            </section>
            <section>
              <label className="label" htmlFor="prompt">
                Prompt{" "}
                <span className="right muted">
                  {settings.prompt.length} chars
                </span>
              </label>
              <div className="mention-wrap">
                <textarea
                  id="prompt"
                  ref={promptRef}
                  value={settings.prompt}
                  placeholder="A neon shop sign that reads QWEN"
                  aria-describedby="promptHint"
                  onChange={(e) => {
                    update("prompt", e.target.value);
                    const match = e.target.value
                      .slice(0, e.target.selectionStart)
                      .match(/@([A-Za-z0-9._-]*)$/);
                    setMentionQuery(match?.[1] ?? null);
                    setMentionIndex(0);
                  }}
                  onBlur={() => setMentionQuery(null)}
                  onKeyDown={(e) => {
                    if (mentionQuery === null || !mentionItems.length) return;
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setMentionQuery(null);
                    }
                    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                      e.preventDefault();
                      setMentionIndex(
                        (i) =>
                          (i +
                            (e.key === "ArrowDown"
                              ? 1
                              : mentionItems.length - 1)) %
                          mentionItems.length,
                      );
                    }
                    if (e.key === "Enter") {
                      e.preventDefault();
                      insertMention(
                        mentionItems[mentionIndex] ?? mentionItems[0],
                        true,
                      );
                    }
                  }}
                />
                {mentionQuery !== null && mentionItems.length > 0 && (
                  <div
                    className="mentions"
                    role="listbox"
                    aria-label="Reference images"
                  >
                    {mentionItems.map((r, i) => (
                      <button
                        className="mention"
                        role="option"
                        aria-selected={mentionIndex === i}
                        key={r.id}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => insertMention(r, true)}
                      >
                        <img src={r.url} alt="" />
                        <span className="num">{refs.indexOf(r) + 1}</span>
                        <span className="name">{r.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <p className="hint" id="promptHint">
                Type @ to name a reference image; it becomes &lt;image1&gt;,
                &lt;image2&gt;… in the order of the list.
              </p>
            </section>
            <section>
              <div className="label">Prompt enhancer</div>
              <Toggle
                title="Enhance prompt"
                checked={settings.enhance}
                onChange={(v) => update("enhance", v)}
                tag={refs.length ? "PE-I2I · 9B" : "PE-T2I · 9B"}
                description="Rewrites prompts with PE-T2I for generation or PE-I2I with your reference images for editing, before loading the image model."
              />
              <Toggle
                title="Let it think"
                checked={settings.think}
                onChange={(v) => update("think", v)}
                disabled={!settings.enhance}
                sub
                description="Reasons before answering. Slower, often by minutes on MPS."
              />
            </section>
            <section>
              <div className="label">
                Aspect ratio{" "}
                <span className="right muted">
                  {settings.ratio ? "chosen" : `auto · ${size.source}`}
                </span>
              </div>
              <div className="ratios">
                {([null, ...Object.keys(RATIOS)] as (Ratio | null)[]).map(
                  (r) => {
                    const [w, h] = r ? RATIOS[r] : [1, 1];
                    return (
                      <button
                        key={r ?? "auto"}
                        className={`ratio${r ? "" : " auto"}`}
                        aria-pressed={settings.ratio === r}
                        onClick={() => update("ratio", r)}
                      >
                        <i
                          style={{
                            width: Math.round((w * 22) / Math.max(w, h)),
                            height: Math.round((h * 22) / Math.max(w, h)),
                          }}
                        />
                        {r ?? "Auto"}
                      </button>
                    );
                  },
                )}
              </div>
              <div className="readout">
                <span>
                  <b>
                    {size.width && size.height
                      ? `${size.width} × ${size.height}`
                      : "—"}
                  </b>{" "}
                  px
                </span>
                <span>
                  <b>
                    {size.width && size.height
                      ? ((size.width * size.height) / 1e6).toFixed(2)
                      : "—"}
                  </b>{" "}
                  MP
                </span>
                <span>
                  ÷32{" "}
                  <b className={gridOK ? "" : "warn"}>
                    {gridOK ? "ok" : "not a multiple"}
                  </b>
                </span>
              </div>
            </section>
            <section>
              <div className="grid2">
                {numberField("width", "Width", 256, 4096)}
                {numberField("height", "Height", 256, 4096)}
              </div>
              <p className="hint">
                Overrides the ratio. Multiples of 32; leave empty to follow the
                ratio.
              </p>
            </section>
            <section className="grid2">
              {numberField("steps", "Steps", 1, 200)}
              <div>
                <label className="label" htmlFor="cfg">CFG</label>
                <input id="cfg" type="number" min="1" max="10" step="0.1"
                  value={effectiveCfg} disabled={anyangleActive}
                  aria-describedby={anyangleActive ? "cfgHint" : undefined}
                  onChange={e => update("cfg", Number(e.target.value))}/>
                {anyangleActive && <p id="cfgHint" className="hint">AnyAngle requires CFG 3</p>}
              </div>
              <div>
                <label className="label" htmlFor="seed">
                  Seed
                </label>
                <div className="seedrow">
                  <input
                    id="seed"
                    type="number"
                    min="0"
                    value={settings.seed}
                    onChange={(e) => update("seed", Number(e.target.value))}
                  />
                  <button
                    className="iconbtn"
                    aria-label="Random seed"
                    title="Random seed"
                    onClick={() =>
                      update(
                        "seed",
                        crypto.getRandomValues(new Uint32Array(1))[0],
                      )
                    }
                  >
                    ⚄
                  </button>
                </div>
              </div>
            </section>
            <section>
              <Toggle
                title="Transparent background"
                tag="RGBA"
                checked={settings.transparent}
                onChange={(v) => update("transparent", v)}
                description="Asks for an alpha channel; the take is always saved as PNG."
              />
            </section>
            </div>
            <div className="parameters-action">
              {error && <p className="errors" role="alert">{error}</p>}
              <button className="primary" disabled={action.disabled}
                onClick={() => action.job ? cancelGeneration(action.job) : generate()}>
                {action.label}
              </button>
            </div>
          </aside>
          <main className="panel center" aria-label="Preview">
            {previewMode === "splat" && splatJob?.state === "completed" && splatJob.output ? (
              <section className="stage splat-stage" aria-label="Splat preview">
                <div className="stagehead"><span className="spacer" /><button className="btn sm" onClick={() => setPreviewMode("image")}>View image</button></div>
                <SplatViewer url={splatJob.output} />
              </section>
            ) : <section className="stage">
              <div className="stagehead">
                <span className="mono">
                  {take
                    ? `${take.generated ? "Take" : "Demo take"} · seed ${take.settings.seed} · ${take.settings.steps} steps`
                    : "No take yet"}
                </span>
                {take && (
                  <span className="chip">
                    {take.width} × {take.height}
                  </span>
                )}
                <span className="spacer" />
                {take?.generated && <button className="btn sm" disabled={splat.disabled}
                  onClick={() => splatJob?.state === "completed" ? setPreviewMode("splat") : generateSplat()}>
                  {splat.label}
                </button>}
                <button
                  className="btn sm"
                  disabled={!take}
                  onClick={useReference}
                >
                  Use as reference
                </button>
                <button
                  className="btn sm"
                  disabled={!take}
                  onClick={() =>
                    take &&
                    setSessions((prev) =>
                      prev.map((s) =>
                        s.id === active
                          ? { ...s, settings: { ...defaults, ...take.settings } }
                          : s,
                      ),
                    )
                  }
                >
                  Reuse settings
                </button>
                {take && (
                  <a
                    className="btn sm"
                    href={take.url}
                    target="_blank"
                    rel="noopener"
                  >
                    Open
                  </a>
                )}
              </div>
              <div
                className="frame"
                style={
                  {
                    "--r": take ? take.width / take.height : 1,
                  } as CSSProperties
                }
              >
                {take ? (
                  <>
                    <img src={take.url} alt={take.settings.prompt} />
                    <span className="badge">
                      {take.generated ? "GENERATED" : "DEMO"} · {take.width} × {take.height}
                    </span>
                  </>
                ) : (
                  <span className="empty">Generate to see a take here</span>
                )}
              </div>
              <div className="pipeline">
                {stages.map((s, i) => {
                  const stageIndex = currentJob ? stages.findIndex(stage => stage.toLowerCase() === currentJob.stage) : -1;
                  const skip = i === 0 && !(currentJob?.settings.enhance ?? settings.enhance);
                  const activeStage = !!currentJob && i === stageIndex;
                  const busy = activeStage && i === 0;
                  const percent = currentJob && !skip
                    ? i < stageIndex ? 100 : activeStage ? (s === "Denoise" ? currentJob.step / currentJob.total * 100 : 25) : 0
                    : 0;
                  return (
                    <div key={s} className={`stepc${skip ? " skip" : ""}${activeStage ? " now" : ""}${busy ? " busy" : ""}`}>
                      <div className="bar" role="progressbar" aria-label={s} aria-valuemin={0} aria-valuemax={100} aria-valuenow={busy ? undefined : percent} aria-valuetext={busy ? "Enhancing prompt" : undefined}>
                        <i style={busy ? undefined : { width: `${percent}%` }} />
                      </div>
                      {s}
                    </div>
                  );
                })}
              </div>
              <p className="demo-note">
                {currentJob ? currentJob.stage === "enhance" ? "Enhancing prompt…" : `${currentJob.stage} · ${currentJob.step}/${currentJob.total}` : "Ready"} ·{" "}
                <button className="link" onClick={loadDemo}>
                  Load demo take
                </button>
              </p>
              {splatJob?.state === "failed" && <p className="errors" role="alert">{splatJob.error}</p>}
            </section>}
            {take?.enhancedPrompt && (
              <section className={`enhanced${expanded ? " open" : ""}`}>
                <div className="label">
                  Enhanced prompt{" "}
                  <span className="right">
                    <button
                      className="link"
                      onClick={() => update("prompt", take.enhancedPrompt!)}
                    >
                      copy to prompt
                    </button>
                    <button
                      className="link"
                      aria-expanded={expanded}
                      aria-controls="enhancedBody"
                      onClick={() => setExpanded(!expanded)}
                    >
                      {expanded ? "collapse" : "expand"}
                    </button>
                  </span>
                </div>
                <div className="enhanced-body" id="enhancedBody">
                  <p className="orig">{take.settings.prompt}</p>
                  <p>{take.enhancedPrompt}</p>
                </div>
              </section>
            )}
            <section>
              <div className="label">
                Takes <span className="muted">{sessionTakes.length}</span>
              </div>
              {takeCards}
              {take && (
                <div className="take-actions">
                  <button
                    className="btn sm danger-text"
                    onClick={() => {
                      setTakes((prev) => ({
                        ...prev,
                        [active]: sessionTakes.filter((t) => t.id !== take.id),
                      }));
                      setSelected(null);
                    }}
                  >
                    Delete selected take
                  </button>
                </div>
              )}
            </section>
          </main>
          <aside className="panel side" aria-label="Inputs and activity">
            <div className="side-scroll">
              <section>
                <div className="label">
                  Reference images{" "}
                  <span className="muted">{refs.length}/10</span>
                </div>
                <label
                  className={`drop${drag ? " drag" : ""}`}
                  htmlFor="fileInput"
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDrag(true);
                  }}
                  onDragLeave={() => setDrag(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDrag(false);
                    void upload(Array.from(e.dataTransfer.files));
                  }}
                >
                  Drop images here or click to add — up to 10. Adding one
                  switches to Edit.
                </label>
                <input
                  id="fileInput"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  hidden
                  onChange={(e) => {
                    void upload(Array.from(e.target.files ?? []));
                    e.target.value = "";
                  }}
                />
                <div className="refs">
                  {refs.map((r, i) => (
                    <div className="ref" key={r.id}>
                      <button
                        className="ref-insert"
                        title={`Add @${r.name} to prompt`}
                        aria-label={`Add @${r.name} to prompt`}
                        onClick={() => insertMention(r)}
                      >
                        <img src={r.url} alt={r.name} />
                      </button>
                      <span className="n">{i + 1}</span>
                      <button
                        className="x"
                        aria-label={`Remove ${r.name}`}
                        onClick={() =>
                          setImages((prev) => ({
                            ...prev,
                            [active]: refs.filter((x) => x.id !== r.id),
                          }))
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                <p className="hint">
                  Numbered in prompt order. Click one to add it to the prompt as
                  @name, sent as &lt;imageN&gt;. With no ratio set, the size
                  follows the last image.
                </p>
              </section>
              <section>
                <div className="label">Queue</div>
                <div className="queue">
                  {jobs.filter(j => j.state === "queued" || j.state === "running" || j.state === "cancelling").length === 0 && <span className="none">No jobs queued</span>}
                  {jobs.filter(j => j.state === "queued" || j.state === "running" || j.state === "cancelling").map(job => (
                    <div key={job.id} className="engine-job">
                      <span>{job.kind === "splat" ? "Splat · " : ""}{job.settings.prompt.slice(0, 60)}</span>
                      <span className="muted">{job.state} · {job.stage}{job.step > 0 ? ` ${job.step}/${job.total}` : ""}</span>
                    </div>
                  ))}
                </div>
              </section>
            </div>
            <section className="side-term">
              <div className="label">
                Terminal{" "}
                <span className="tabs" role="tablist" aria-label="Terminal">
                  <button
                    role="tab"
                    aria-selected={tab === "output"}
                    onClick={() => setTab("output")}
                  >
                    Output
                  </button>
                  <button
                    role="tab"
                    aria-selected={tab === "render"}
                    onClick={() => setTab("render")}
                  >
                    Render log
                  </button>
                </span>
                <span className="right">
                  <button className="link" onClick={() => setLogs([])}>
                    clear
                  </button>
                </span>
              </div>
              <pre className="term" role="tabpanel">
                {tab === "output"
                  ? logs.join("\n")
                  : jobs.filter(j => j.session === active).map(j => [`[${j.id.slice(0, 8)}] ${j.state}${j.error ? `: ${j.error}` : ""}`, ...j.logs].join("\n")).join("\n\n") || "No renders yet."}
              </pre>
            </section>
          </aside>
        </div>
      )}
      {dialog && (
        <Dialog
          title={
            dialog === "gallery"
                ? "Gallery"
                : dialog === "delete"
                  ? `Delete ${current.name}?`
                  : dialog === "duplicate"
                    ? "Duplicate session"
                    : "New session"
          }
          wide={dialog === "gallery"}
          onClose={() => setDialog(null)}
        >
          {dialog === "gallery" ? (
            <>
              {takeCards}
              <p className="hint">
                Local demo takes for this session. Helmstudio gallery is not
                connected.
              </p>
            </>
          ) : dialog === "delete" ? (
            <>
              <p>Its settings and references will be removed from this UI.</p>
              <div className="acts">
                <button className="btn" onClick={() => setDialog(null)}>
                  Cancel
                </button>
                <button className="btn danger-text" disabled={controlsBusy} onClick={deleteSession}>
                  Delete
                </button>
              </div>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                saveSession();
              }}
            >
              <label>
                <span className="label">Session name</span>
                <input
                  autoFocus
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              {dialogError && (
                <p className="errors" role="alert">
                  {dialogError}
                </p>
              )}
              <div className="acts">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setDialog(null)}
                >
                  Cancel
                </button>
                <button className="primary" type="submit" disabled={controlsBusy}>
                  {dialog === "duplicate" ? "Duplicate" : "Create"}
                </button>
              </div>
            </form>
          )}
        </Dialog>
      )}
    </div>
  );
}
