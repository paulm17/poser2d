use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::{mpsc, watch},
};
use uuid::Uuid;

#[derive(Clone, Deserialize, Serialize)]
pub struct Settings {
    pub prompt: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub steps: u32,
    #[serde(default = "default_cfg")]
    pub cfg: f32,
    pub seed: u64,
    pub enhance: bool,
    pub think: bool,
    pub transparent: bool,
    pub device: String,
    pub ratio: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Paths {
    #[serde(default)]
    pub lightning_lora: String,
    #[serde(default)]
    pub anyangle_lora: String,
    #[serde(default)]
    pub anyangle_enabled: bool,
    #[serde(default = "default_cfg")]
    pub anyangle_strength: f32,
    #[serde(default)]
    pub lightning_enabled: bool,
    #[serde(default)]
    pub pose_lora: String,
    #[serde(default)]
    pub pose_enabled: bool,
    #[serde(default = "pose_strength")]
    pub pose_strength: f32,
    #[serde(default)]
    pub pe_cli: String,
    #[serde(default)]
    pub pe_model: String,
    #[serde(default)]
    pub pe_system: String,
    #[serde(default)]
    pub pe_i2i_model: String,
    #[serde(default)]
    pub pe_i2i_system: String,
    #[serde(default)]
    pub turbo: bool,
    pub cli: String,
    pub model: String,
    #[serde(default)]
    pub model8: String,
    #[serde(default = "default_bits")]
    pub quant_bits: u8,
    pub vae: String,
    pub llm: String,
    pub vision: String,
}
fn default_cfg() -> f32 { 1.0 }
fn default_bits() -> u8 {
    4
}
fn pose_strength() -> f32 {
    0.7
}

#[derive(Deserialize)]
pub struct Reference {
    pub png: String,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct AdapterSelection {
    pub id: String,
    pub strength: f32,
}
#[derive(Deserialize)]
pub struct Request {
    #[serde(default)]
    pub loras: Option<Vec<AdapterSelection>>,
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub auto_ratio: bool,
    pub session: String,
    pub settings: Settings,
    #[serde(default = "default_paths")]
    pub paths: Paths,
    pub references: Vec<Reference>,
}
#[derive(Clone, Serialize)]
pub struct Job {
    pub enhanced_prompt: Option<String>,
    pub revision: u64,
    pub id: String,
    pub session: String,
    pub settings: Settings,
    pub state: String,
    pub stage: String,
    pub step: u32,
    pub total: u32,
    pub logs: Vec<String>,
    pub error: Option<String>,
    pub output: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}
struct Enhancement {
    cli: String,
    model: String,
    system: String,
    prompt: String,
    think: bool,
    auto_ratio: bool,
    references: Vec<PathBuf>,
}
struct Work {
    enhancement: Option<Enhancement>,
    references: Vec<Reference>,
    id: String,
    args: Vec<String>,
    pose_modules: usize,
    anyangle_modules: usize,
    lightning_modules: usize,
    paths: Paths,
    cli: PathBuf,
    dir: PathBuf,
}
struct State {
    last_emit: HashMap<String, u64>,
    jobs: Vec<Job>,
    cancels: HashMap<String, watch::Sender<bool>>,
    sender: Option<rust_cef::FrontendEventSender>,
}
pub struct Engine {
    state: Mutex<State>,
    queue: mpsc::Sender<Work>,
    root: PathBuf,
}
impl Engine {
    pub fn new(root: PathBuf, runtime: &tokio::runtime::Handle) -> Arc<Self> {
        let (tx, mut rx) = mpsc::channel::<Work>(32);
        let engine = Arc::new(Self {
            state: Mutex::new(State {
                last_emit: HashMap::new(),
                jobs: vec![],
                cancels: HashMap::new(),
                sender: None,
            }),
            queue: tx,
            root,
        });
        let worker = engine.clone();
        runtime.spawn(async move {
            while let Some(work) = rx.recv().await {
                worker.run(work).await;
            }
        });
        let events = Arc::downgrade(&engine);
        runtime.spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                let Some(engine) = events.upgrade() else {
                    break;
                };
                engine.flush_events();
            }
        });
        engine
    }
    pub fn set_sender(&self, sender: rust_cef::FrontendEventSender) {
        self.state.lock().unwrap().sender = Some(sender);
    }
    pub fn snapshot(&self) -> Value {
        json!({"jobs": self.state.lock().unwrap().jobs})
    }
    fn update(&self, id: &str, change: impl FnOnce(&mut Job)) {
        let mut state = self.state.lock().unwrap();
        if let Some(job) = state.jobs.iter_mut().find(|j| j.id == id) {
            change(job);
            job.revision += 1;
        }
    }
    fn flush_events(&self) {
        let (sender, jobs) = {
            let mut state = self.state.lock().unwrap();
            let Some(sender) = state.sender.clone() else {
                return;
            };
            let jobs: Vec<_> = state
                .jobs
                .iter()
                .filter(|j| state.last_emit.get(&j.id) != Some(&j.revision))
                .cloned()
                .collect();
            for job in &jobs {
                state.last_emit.insert(job.id.clone(), job.revision);
            }
            (sender, jobs)
        };
        for job in jobs {
            let _ = sender.emit("engine-job", json!(job));
        }
    }
    pub fn cancel(&self, id: &str) -> Result<Value, String> {
        let mut state = self.state.lock().unwrap();
        let cancel = state
            .cancels
            .get(id)
            .ok_or("Job is no longer cancellable")?;
        cancel.send_replace(true);
        let queued = state.jobs.iter().any(|j| j.id == id && j.state == "queued");
        if queued {
            state.cancels.remove(id);
        }
        drop(state);
        self.update(id, |job| {
            job.state = if queued { "cancelled" } else { "cancelling" }.into();
        });
        Ok(json!({"ok": true}))
    }
    pub fn shutdown(&self) {
        for cancel in self.state.lock().unwrap().cancels.values() {
            cancel.send_replace(true);
        }
    }
    pub fn submit(&self, mut request: Request) -> Result<Value, String> {
        if let Some(id) = &request.model_id {
            let pose = request.paths.pose_enabled;
            let lightning = request.paths.lightning_enabled;
            let anyangle = request.paths.anyangle_enabled;
            let anyangle_strength = request.paths.anyangle_strength;
            let mut paths = cached_paths(default_cli());
            let selected = model_catalog()
                .into_iter()
                .find(|m| &m.id == id)
                .ok_or("Unknown model selection")?;
            if !selected.available {
                return Err("Selected model is not installed".into());
            }
            paths.model = selected.path;
            paths.model8 = paths.model.clone();
            paths.quant_bits = selected.bits;
            paths.turbo = selected.turbo;
            paths.vae = PathBuf::from(&paths.model)
                .join("vae")
                .to_string_lossy()
                .into_owned();
            paths.llm = PathBuf::from(&paths.model)
                .join("text_encoder")
                .to_string_lossy()
                .into_owned();
            paths.pose_enabled = pose;
            paths.anyangle_enabled = anyangle;
            paths.anyangle_strength = anyangle_strength;
            paths.lightning_enabled = lightning && !paths.turbo;
            request.paths = paths;
        }
        if let Some(loras) = &request.loras {
            apply_adapter_selection(&mut request.paths, loras)?;
        }
        if request.paths.turbo {
            request.settings.steps = 8;
        } else if request.paths.lightning_enabled {
            request.settings.steps = 4;
        }
        if request.paths.quant_bits == 8 {
            request.paths.model = request.paths.model8.clone();
        }
        if request.settings.enhance && !request.references.is_empty() {
            request.paths.pe_model = request.paths.pe_i2i_model.clone();
            request.paths.pe_system = request.paths.pe_i2i_system.clone();
        }
        if request.paths.anyangle_enabled { request.settings.cfg = 3.0; }
        validate(&request)?;
        for path in [
            &mut request.paths.cli,
            &mut request.paths.model,
            &mut request.paths.vae,
            &mut request.paths.llm,
        ] {
            *path = std::fs::canonicalize(&*path)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .into_owned();
        }

        if request.settings.enhance {
            if !std::path::Path::new(&request.paths.pe_model).is_absolute() {
                request.paths.pe_model = std::env::current_dir()
                    .map_err(|e| e.to_string())?
                    .join(&request.paths.pe_model)
                    .to_string_lossy()
                    .into_owned();
            }
            for path in [
                &mut request.paths.pe_cli,
                &mut request.paths.pe_system,
                &mut request.paths.pe_model,
            ] {
                *path = std::fs::canonicalize(&*path)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .into_owned();
            }
        }
        if request.paths.pose_enabled && !request.references.is_empty() {
            request.paths.pose_lora = std::fs::canonicalize(&request.paths.pose_lora)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .into_owned();
        }
        let cli = PathBuf::from(&request.paths.cli);
        if !cli.is_file() {
            return Err("Select an existing vpipe executable".into());
        }
        let lightning_modules = if request.paths.lightning_enabled {
            request.paths.lightning_lora = std::fs::canonicalize(&request.paths.lightning_lora)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .into_owned();
            adapter_modules(&request.paths.lightning_lora)?
        } else {
            0
        };
        let pose_modules = if request.paths.pose_enabled && !request.references.is_empty() {
            adapter_modules(&request.paths.pose_lora)?
        } else {
            0
        };
        let anyangle_modules = if request.paths.anyangle_enabled {
            request.paths.anyangle_lora = std::fs::canonicalize(&request.paths.anyangle_lora).map_err(|e| e.to_string())?.to_string_lossy().into_owned();
            adapter_modules(&request.paths.anyangle_lora)?
        } else { 0 };
        let id = Uuid::new_v4().to_string();
        let dir = self.root.join(&id);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        if request
            .references
            .iter()
            .any(|r| r.png.len() > 48 * 1024 * 1024)
        {
            let _ = std::fs::remove_dir_all(&dir);
            return Err("Reference image exceeds 36 MB".into());
        }
        let refs: Vec<_> = (0..request.references.len())
            .map(|i| dir.join(format!("reference-{i}.png")))
            .collect();
        let args = arguments(&request, &refs, &dir.join("output.png"));

        let enhancement = request.settings.enhance.then(|| Enhancement {
            cli: request.paths.pe_cli.clone(),
            model: request.paths.pe_model.clone(),
            system: request.paths.pe_system.clone(),
            prompt: request.settings.prompt.clone(),
            think: request.settings.think,
            auto_ratio: request.auto_ratio && request.settings.ratio.is_none(),
            references: refs.clone(),
        });
        let (cancel, _) = watch::channel(false);
        {
            let mut state = self.state.lock().unwrap();
            if state
                .jobs
                .iter()
                .filter(|j| matches!(j.state.as_str(), "queued" | "running" | "cancelling"))
                .count()
                >= 32
            {
                let _ = std::fs::remove_dir_all(&dir);
                return Err("Queue is full (32 jobs)".into());
            }
            state.cancels.insert(id.clone(), cancel);
            state.jobs.push(Job {
                enhanced_prompt: None,
                revision: 0,
                id: id.clone(),
                session: request.session,
                settings: request.settings.clone(),
                state: "queued".into(),
                stage: "load".into(),
                step: 0,
                total: request.settings.steps,
                logs: vec![],
                error: None,
                output: None,
                width: None,
                height: None,
            });
        }
        if let Err(e) = self.queue.try_send(Work {
            enhancement,
            paths: request.paths.clone(),
            references: request.references,
            id: id.clone(),
            args,
            pose_modules,
            anyangle_modules,
            lightning_modules,
            cli,
            dir: dir.clone(),
        }) {
            let mut state = self.state.lock().unwrap();
            state.jobs.retain(|j| j.id != id);
            state.cancels.remove(&id);
            let _ = std::fs::remove_dir_all(dir);
            return Err(e.to_string());
        }
        // The snapshot handshake also covers a worker that starts before submit returns.
        Ok(json!({"id": id}))
    }
    async fn run(self: &Arc<Self>, mut work: Work) {
        let mut cancel = {
            let state = self.state.lock().unwrap();
            let Some(tx) = state.cancels.get(&work.id) else {
                let _ = std::fs::remove_dir_all(&work.dir);
                return;
            };
            tx.subscribe()
        };
        if *cancel.borrow() {
            self.finish(&work.id, "cancelled", None);
            let _ = std::fs::remove_dir_all(&work.dir);
            return;
        }
        self.update(&work.id, |j| j.state = "running".into());
        let references = std::mem::take(&mut work.references);
        let dir = work.dir.clone();
        let prepared =
            tokio::task::spawn_blocking(move || prepare_references(references, &dir)).await;
        if *cancel.borrow() {
            self.finish(&work.id, "cancelled", None);
            let _ = std::fs::remove_dir_all(&work.dir);
            return;
        }
        if let Err(error) = prepared.map_err(|e| e.to_string()).and_then(|r| r) {
            self.finish(&work.id, "failed", Some(error));
            return;
        }

        if let Some(enhancement) = &work.enhancement {
            self.update(&work.id, |j| j.stage = "enhance".into());
            match self.enhance(enhancement, &work.id, &mut cancel).await {
                Ok(Some((prompt, ratio, follow))) => {
                    let mut graph: Value =
                        serde_json::from_str(&work.args[1]).expect("generated graph");
                    // Preserve the transparency instructions applied by arguments().
                    graph["stages"][1]["config"]["text"] = json!(if self
                        .state
                        .lock()
                        .unwrap()
                        .jobs
                        .iter()
                        .find(|j| j.id == work.id)
                        .unwrap()
                        .settings
                        .transparent
                    {
                        format!(
                            "This is an RGBA image with transparency. {prompt} The image has alpha channel and the background is transparent."
                        )
                    } else {
                        prompt.clone()
                    });
                    if enhancement.auto_ratio {
                        let size = if follow.is_empty() {
                            ratio_size(&ratio)
                        } else {
                            reference_index(&follow, enhancement.references.len())
                                .ok()
                                .and_then(|i| {
                                    image::image_dimensions(&enhancement.references[i]).ok()
                                })
                                .map(|(w, h)| reference_size(w, h))
                        };
                        if let Some((w, h)) = size {
                            for stage in graph["stages"].as_array_mut().unwrap() {
                                if stage["id"] == "generate-image" {
                                    stage["config"]["width"] = json!(w);
                                    stage["config"]["height"] = json!(h);
                                }
                            }
                        }
                    }
                    work.args[1] = graph.to_string();
                    self.update(&work.id, |j| {
                        j.enhanced_prompt = Some(prompt);
                        j.stage = "load".into();
                    });
                }
                Ok(None) => {
                    self.finish(&work.id, "cancelled", None);
                    let _ = std::fs::remove_dir_all(&work.dir);
                    return;
                }
                Err(error) => {
                    self.finish(&work.id, "failed", Some(error));
                    return;
                }
            }
        }
        if *cancel.borrow() {
            self.finish(&work.id, "cancelled", None);
            return;
        }

        let pack = work.dir.join("model");
        if let Err(e) = assemble_model(&work.paths, &pack) {
            self.finish(&work.id, "failed", Some(e));
            return;
        }
        let mut graph: Value = serde_json::from_str(&work.args[1]).expect("generated graph");
        match finalize_reference_sizes(&mut graph) {
            Ok(messages) => {
                for message in messages {
                    self.log(&work.id, &message);
                }
            }
            Err(error) => {
                self.finish(&work.id, "failed", Some(error));
                return;
            }
        }
        graph["stages"][0]["config"]["hf_dir"] = json!(pack);
        work.args[1] = graph.to_string();
        self.log(
            &work.id,
            &format!(
                "[vpipe] {}-bit model {}",
                work.paths.quant_bits, work.paths.model
            ),
        );
        let pipeline = work.dir.join("pipeline.json");
        if let Err(e) = std::fs::write(&pipeline, &work.args[1]) {
            self.finish(&work.id, "failed", Some(e.to_string()));
            return;
        }
        work.args[1] = pipeline.to_string_lossy().into_owned();
        self.log(
            &work.id,
            &format!("[vpipe] pipeline {}", pipeline.display()),
        );
        let started = std::time::Instant::now();
        let mut command = Command::new("/usr/bin/time");
        command.args(["-l", &work.cli.to_string_lossy()]);

        command
            .args(&work.args)
            .stdin(Stdio::null())
            // Bound VAE working sets on the M1/macOS 15 validation host.
            // 32 latent cells = 512 output pixels with Qwen 2.1's /16 VAE.
            .env(
                "VPIPE_VAE_TILE",
                std::env::var("VPIPE_VAE_TILE").unwrap_or_else(|_| "32".into()),
            )
            .current_dir(&work.dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .process_group(0);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(e) => {
                self.finish(&work.id, "failed", Some(e.to_string()));
                return;
            }
        };
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let a = self.clone();
        let id_a = work.id.clone();
        let out = tokio::spawn(async move { a.read(stdout, &id_a).await });
        let b = self.clone();
        let id_b = work.id.clone();
        let err = tokio::spawn(async move { b.read(stderr, &id_b).await });
        let result = tokio::select! { biased;
            _ = async { if !*cancel.borrow() { let _ = cancel.changed().await; } } => { if let Some(pid) = child.id() { unsafe { libc::kill(-(pid as i32), libc::SIGKILL); } } let _ = child.wait().await; None },
            result = child.wait() => Some(result),
        };
        let _ = out.await;
        let _ = err.await;
        if result.is_none() || *cancel.borrow() {
            self.finish(&work.id, "cancelled", None);
            let _ = std::fs::remove_dir_all(&work.dir);
            return;
        }
        self.log(
            &work.id,
            &format!(
                "[vpipe] elapsed {:.3} seconds",
                started.elapsed().as_secs_f64()
            ),
        );
        match result.unwrap() {
            Ok(status) if status.success() => {
                for (label, path, count) in [
                    ("Pose", &work.paths.pose_lora, work.pose_modules),
                    ("AnyAngle", &work.paths.anyangle_lora, work.anyangle_modules),
                    (
                        "Lightning",
                        &work.paths.lightning_lora,
                        work.lightning_modules,
                    ),
                ] {
                    if count == 0 {
                        continue;
                    }
                    let log =
                        std::fs::read_to_string(work.dir.join("render.log")).unwrap_or_default();
                    let expected = format!("-- {count} modules at scale");
                    if !log.lines().any(|line| {
                        line.contains("runtime LoRA")
                            && line.contains(path)
                            && line.contains(&expected)
                    }) || log.contains("SKIPPED (shape mismatch)")
                    {
                        self.finish(
                            &work.id,
                            "failed",
                            Some(format!(
                                "{label} did not bind all {count} adapter modules; see render log"
                            )),
                        );
                        return;
                    }
                }
                let path = work.dir.join("output.png");
                let output = image::image_dimensions(&path)
                    .map_err(|e| e.to_string())
                    .and_then(|(w, h)| {
                        let token = rust_cef::state::register_file_stream(
                            rust_cef::state::FileStreamEntry {
                                path: path.to_string_lossy().into_owned(),
                                mime_type: "image/png".into(),
                            },
                        )?;
                        Ok((format!("app://localhost/__stream__/{token}"), w, h))
                    });
                match output {
                    Ok((url, w, h)) => self.update(&work.id, |j| {
                        j.output = Some(url);
                        j.width = Some(w);
                        j.height = Some(h);
                        j.stage = "save".into();
                        j.step = j.total;
                        j.state = "completed".into();
                    }),
                    Err(e) => self.finish(
                        &work.id,
                        "failed",
                        Some(format!("No valid output image: {e}")),
                    ),
                }
                self.state.lock().unwrap().cancels.remove(&work.id);
            }
            Ok(status) => self.finish(
                &work.id,
                "failed",
                Some(format!("vpipe exited with {status}; see render log")),
            ),
            Err(e) => self.finish(&work.id, "failed", Some(e.to_string())),
        }
        for i in 0..10 {
            let _ = std::fs::remove_file(work.dir.join(format!("reference-{i}.png")));
        }
    }
    async fn enhance(
        self: &Arc<Self>,
        pe: &Enhancement,
        id: &str,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<Option<(String, String, String)>, String> {
        self.log(
            id,
            &format!(
                "[enhance] Loading {}. Image generation waits until this process exits.",
                if pe.references.is_empty() {
                    "PE-T2I"
                } else {
                    "PE-I2I"
                }
            ),
        );
        let system = std::fs::read_to_string(&pe.system).map_err(|e| e.to_string())?;
        let dir = self.root.join(id);
        let config = dir.join("enhancer.vpipeline");
        let graph = enhancement_pipeline(pe, &system, &dir.join("enhanced.txt"));
        std::fs::write(&config, graph.to_string()).map_err(|e| e.to_string())?;
        let mut command = Command::new("/usr/bin/time");
        command.args(["-l", &pe.cli]);
        command
            .args([
                "--launch",
                &config.to_string_lossy(),
                "--config",
                VPIPE_CONFIG,
            ])
            .current_dir(&dir)
            .process_group(0);
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Could not start enhancer: {e}"))?;
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let a = self.clone();
        let job = id.to_string();
        let output = tokio::spawn(async move { a.capture(stdout, &job).await });
        let b = self.clone();
        let job = id.to_string();
        let logs = tokio::spawn(async move { b.capture(stderr, &job).await });
        let status = tokio::select! { biased;
            _ = async { if !*cancel.borrow() { let _ = cancel.changed().await; } } => { if let Some(pid) = child.id() { unsafe { libc::kill(-(pid as i32), libc::SIGKILL); } } let _ = child.wait().await; None },
            status = child.wait() => Some(status.map_err(|e| e.to_string())?),
        };
        let stdout = output.await.map_err(|e| e.to_string())?;
        let stderr = logs.await.map_err(|e| e.to_string())?;
        if status.is_none() || *cancel.borrow() {
            return Ok(None);
        }
        if !pe.references.is_empty()
            && [&stdout, &stderr].iter().any(|log| {
                log.contains("dropping image attachment") || log.contains("dropping the attachment")
            })
        {
            return Err("PE-I2I could not encode a reference image; see render log".into());
        }
        if !status.unwrap().success() {
            return Err("Prompt enhancer failed; see render log".into());
        }
        let text = std::fs::read_to_string(dir.join("enhanced.txt"))
            .map_err(|e| format!("Enhancer produced no reply: {e}"))?;
        let parsed = parse_enhancement(&text)?;
        if !pe.references.is_empty() && parsed.1.is_empty() && parsed.2.is_empty() {
            return Err("PE-I2I returned no canvas aspect ratio".into());
        }
        if !parsed.2.is_empty() {
            reference_index(&parsed.2, pe.references.len())?;
        }
        self.log(
            id,
            "[enhance] Prompt ready; enhancer process exited and its memory has been released.",
        );
        Ok(Some(parsed))
    }
    async fn capture(&self, mut stream: impl AsyncRead + Unpin, id: &str) -> String {
        let mut result = Vec::new();
        let mut buffer = [0; 4096];
        while let Ok(n) = stream.read(&mut buffer).await {
            if n == 0 {
                break;
            }
            if result.len() + n <= 4 * 1024 * 1024 {
                result.extend_from_slice(&buffer[..n]);
            }
            self.log(
                id,
                &format!("[enhance] {}", String::from_utf8_lossy(&buffer[..n])),
            );
        }
        String::from_utf8_lossy(&result).into_owned()
    }
    fn finish(&self, id: &str, status: &str, error: Option<String>) {
        self.state.lock().unwrap().cancels.remove(id);
        self.update(id, |j| {
            j.state = status.into();
            j.error = error;
        });
    }
    async fn read(&self, mut stream: impl AsyncRead + Unpin, id: &str) {
        let mut buffer = [0; 4096];
        let mut line = Vec::new();
        loop {
            match stream.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    for byte in &buffer[..n] {
                        if *byte == b'\r' || *byte == b'\n' || line.len() >= 16384 {
                            if !line.is_empty() {
                                self.log(id, &String::from_utf8_lossy(&line));
                                line.clear();
                            }
                        }
                        if *byte != b'\r' && *byte != b'\n' {
                            line.push(*byte);
                        }
                    }
                }
            }
        }
        if !line.is_empty() {
            self.log(id, &String::from_utf8_lossy(&line));
        }
    }
    fn log(&self, id: &str, text: &str) {
        let text = text.replace("\u{1b}[K", "");
        self.update(id, |j| {
            if let Some((step, total)) = progress(&text, j.total) {
                if total == j.total {
                    j.stage = "denoise".into();
                    j.step = step;
                }
            }
            let lower = text.to_lowercase();
            if j.stage != "enhance"
                && (lower.contains("decoding")
                    || lower.contains("'vae decode'")
                    || lower.contains("vaedecodestage") && lower.contains("loading"))
            {
                j.stage = "decode".into();
                j.step = j.total;
            }
            if j.stage != "enhance"
                && (lower.contains("save result")
                    || lower.contains("saveimagestage") && lower.contains("wrote"))
            {
                j.stage = "save".into();
            }
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.root.join(id).join("render.log"))
            {
                use std::io::Write;
                let _ = writeln!(f, "{text}");
            }
            j.logs.push(text);
            if j.logs.len() > 500 {
                j.logs.remove(0);
            }
        });
    }
}
fn prepare_references(references: Vec<Reference>, dir: &std::path::Path) -> Result<(), String> {
    for (i, reference) in references.into_iter().enumerate() {
        let bytes = STANDARD
            .decode(reference.png)
            .map_err(|e| format!("Invalid reference: {e}"))?;
        let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|e| e.to_string())?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(8192);
        limits.max_image_height = Some(8192);
        reader.limits(limits);
        reader
            .decode()
            .map_err(|e| format!("Invalid reference image: {e}"))?
            .save(dir.join(format!("reference-{i}.png")))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn validate(r: &Request) -> Result<(), String> {
    if !r.settings.cfg.is_finite() || !(1.0..=10.0).contains(&r.settings.cfg) { return Err("CFG must be between 1 and 10".into()); }
    if r.paths.anyangle_enabled {
        if !PathBuf::from(&r.paths.anyangle_lora).is_file() { return Err("AnyAngle LoRA is not installed".into()); }
        if !r.paths.anyangle_strength.is_finite() || !(0.0..=2.0).contains(&r.paths.anyangle_strength) { return Err("AnyAngle LoRA strength must be between 0 and 2".into()); }
    }

    let s = &r.settings;
    if r.session.is_empty() || s.prompt.trim().is_empty() {
        return Err("Session and prompt are required".into());
    }
    if s.enhance {
        if !PathBuf::from(&r.paths.pe_model).is_dir()
            || !PathBuf::from(&r.paths.pe_model)
                .join("config.json")
                .is_file()
        {
            return Err("Select a prepared prompt enhancer Safetensors model directory".into());
        }

        for (label, path) in [
            ("vpipe enhancer executable", &r.paths.pe_cli),
            ("Prompt enhancer weights", &r.paths.pe_model),
            ("Prompt enhancer system prompt", &r.paths.pe_system),
        ] {
            if !PathBuf::from(path).exists() {
                return Err(format!("Select existing {label}"));
            }
        }
    }
    if r.paths.turbo && s.steps != 8 {
        return Err("Turbo generation requires 8 steps".into());
    }
    if !(1..=200).contains(&s.steps) || s.seed > 9_007_199_254_740_991 {
        return Err("Invalid steps or seed".into());
    }
    for n in [s.width, s.height] {
        if !n.is_some_and(|n| (256..=4096).contains(&n) && n % 32 == 0) {
            return Err("Dimensions must be multiples of 32 between 256 and 4096".into());
        }
    }
    if !matches!(s.device.as_str(), "auto" | "mps") {
        return Err("vpipe requires Apple Silicon Metal".into());
    }
    if r.references.len() > 10 {
        return Err("At most 10 references are supported".into());
    }
    for (name, path) in [
        ("diffusion model", &r.paths.model),
        ("VAE", &r.paths.vae),
        ("text encoder", &r.paths.llm),
    ] {
        if !PathBuf::from(path).is_dir()
            || !PathBuf::from(path)
                .join(if name == "diffusion model" {
                    "transformer/config.json"
                } else {
                    "config.json"
                })
                .is_file()
        {
            return Err(format!(
                "Select an existing {name} Safetensors model directory"
            ));
        }
    }
    let config: Value = serde_json::from_slice(
        &std::fs::read(PathBuf::from(&r.paths.model).join("transformer/config.json"))
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let index: Value = serde_json::from_slice(
        &std::fs::read(PathBuf::from(&r.paths.model).join("model_index.json"))
            .map_err(|e| format!("Sampling configuration is missing: {e}"))?,
    )
    .map_err(|e| e.to_string())?;
    if config["_class_name"] != "QwenImage21Transformer2DModel"
        || (r.paths.turbo && index["sample_sigmas"].as_array().map(Vec::len) != Some(8))
    {
        return Err("Selected Qwen model has an invalid sampling configuration".into());
    }
    if config["quantization"]["bits"].as_u64() != Some(r.paths.quant_bits as u64) {
        return Err(format!(
            "Selected model must be a prepared {}-bit transformer",
            r.paths.quant_bits
        ));
    }
    if r.paths.lightning_enabled && !PathBuf::from(&r.paths.lightning_lora).is_file() {
        return Err("Lightning LoRA is not installed".into());
    }
    if r.paths.pose_enabled && !r.references.is_empty() {
        let path = PathBuf::from(&r.paths.pose_lora);
        if !path.is_file() {
            return Err("Select an existing PoseStudio LoRA or disable it".into());
        }
        if !r.paths.pose_strength.is_finite() || !(0.0..=2.0).contains(&r.paths.pose_strength) {
            return Err("PoseStudio LoRA strength must be between 0 and 2".into());
        }
    }
    if !matches!(r.paths.quant_bits, 4 | 8) {
        return Err("Choose 4-bit or 8-bit weights".into());
    }

    Ok(())
}
const VPIPE_CONFIG: &str = r#"{"log":{"level":"normal","delegate":"stdout"},"db":{"path":"."}}"#;

fn port(src: &str) -> Value {
    json!({"src":src,"oport":0})
}
fn stage(id: &str, kind: &str, inputs: Vec<Value>, config: Value) -> Value {
    json!({"id":id,"type":kind,"iports":inputs,"config":config})
}
fn arguments(r: &Request, refs: &[PathBuf], output: &std::path::Path) -> Vec<String> {
    vec![
        "--launch".into(),
        image_pipeline(r, refs, output).to_string(),
        "--config".into(),
        VPIPE_CONFIG.into(),
    ]
}
fn image_pipeline(r: &Request, refs: &[PathBuf], output: &std::path::Path) -> Value {
    let prompt = if r.settings.transparent {
        format!(
            "This is an RGBA image with transparency. {} The image has alpha channel and the background is transparent.",
            r.settings.prompt
        )
    } else {
        r.settings.prompt.clone()
    };
    let mut cfg = json!({"use_kv_cache":!r.paths.lightning_enabled});
    if r.paths.lightning_enabled {
        cfg["lora"] = json!(r.paths.lightning_lora);
        cfg["lora_scale"] = json!(
            r.loras
                .as_ref()
                .and_then(|a| a.iter().find(|a| a.id == "lightning"))
                .map(|a| a.strength)
                .unwrap_or(1.0)
        );
        cfg["sigmas"] = json!([1.0, 0.75, 0.5, 0.25]);
        cfg["shift_terminal"] = json!(0.0);
    }
    if r.paths.pose_enabled && !refs.is_empty() {
        cfg["lora2"] = json!(r.paths.pose_lora);
        cfg["lora2_scale"] = json!(r.paths.pose_strength);
    }
    if r.paths.anyangle_enabled {
        cfg["lora3"] = json!(r.paths.anyangle_lora);
        cfg["lora3_scale"] = json!(r.paths.anyangle_strength);
    }
    let guidance = if r.paths.anyangle_enabled { 3.0 } else { r.settings.cfg };
    let mut stages = vec![
        stage(
            "model-select",
            "model-select",
            vec![],
            json!({"hf_dir":r.paths.model}),
        ),
        stage("text-prompt", "text-prompt", vec![], json!({"text":prompt})),
        stage("model-config", "qwen-image-21-model-config", vec![], cfg),
    ];
    let multi = refs.len() > 1;
    if multi {
        let mut inputs = Vec::new();
        for (i, reference) in refs.iter().enumerate() {
            let load = format!("load-ref-{i}");
            let resize = format!("ref-resample-{i}");
            stages.push(stage(&load, "load-image", vec![], json!({"url":reference})));
            stages.push(stage(
                &resize,
                "image-resample",
                vec![port(&load)],
                json!({"fit":"stretch","algorithm":"bilinear"}),
            ));
            inputs.push(port(&resize));
        }
        stages.push(stage("ref-list", "tensor-list", inputs, json!({})));
        stages.push(stage(
            "vae-encode",
            "vae-encode",
            vec![port(""), port("model-select"), port("ref-list")],
            json!({"unload_when_idle":"always"}),
        ));
    } else if !refs.is_empty() {
        stages.push(stage("load-ref", "load-image", vec![], json!({"url":refs})));
        stages.push(stage(
            "ref-resample",
            "image-resample",
            vec![port("load-ref")],
            json!({"fit":"stretch","algorithm":"bilinear"}),
        ));
        stages.push(stage(
            "vae-encode",
            "vae-encode",
            vec![port("ref-resample"), port("model-select")],
            json!({"unload_when_idle":"always"}),
        ));
    }
    let ref_port = if refs.is_empty() || multi {
        ""
    } else {
        "ref-resample"
    };
    stages.push(stage(
        "diffusion-conditioner",
        "diffusion-conditioner",
        vec![
            port("text-prompt"),
            port(""),
            port("model-select"),
            port(ref_port),
            port(""),
            port("model-config"),
            port(if multi { "ref-list" } else { "" }),
        ],
        json!({"unload_when_idle":"always", "grounded_negative":guidance > 1.0}),
    ));
    let mut generation_inputs = vec![
        port("diffusion-conditioner"),
        port(""),
        port("model-select"),
        port(""),
        port(""),
        port(if refs.is_empty() || multi {
            ""
        } else {
            "vae-encode"
        }),
        port(""),
        port("model-config"),
        port(""),
    ];
    if guidance > 1.0 { generation_inputs[1] = json!({"src":"diffusion-conditioner","oport":1}); }
    if multi {
        generation_inputs[8] = json!({"src":"vae-encode","oport":1});
    }
    stages.push(stage(
        "generate-image",
        "generate-image",
        generation_inputs,
        json!({"width":r.settings.width,"height":r.settings.height,"seed":r.settings.seed,
            "steps":r.settings.steps,"guidance_scale":guidance,"unload_when_idle":"always"}),
    ));
    stages.push(stage(
        "vae-decode",
        "vae-decode",
        vec![port("generate-image"), port("model-select")],
        json!({"unload_when_idle":"always"}),
    ));
    stages.push(stage(
        "save-image",
        "save-image",
        vec![port("vae-decode")],
        json!({"path":output,"format":"png","compression":6}),
    ));
    json!({"id":"studio-image","stages":stages,"subpipelines":[]})
}
fn enhancement_pipeline(pe: &Enhancement, system: &str, output: &std::path::Path) -> Value {
    let edit = !pe.references.is_empty();
    let mut content = String::new();
    for path in &pe.references {
        content.push_str(&format!(
            "<|__vpipe_fs_im_start__|>{}<|__vpipe_fs_im_end__|>\n",
            path.display()
        ));
    }
    content.push_str(&pe.prompt);
    json!({"id":"studio-enhance","subpipelines":[],"stages":[
        stage("input","text-prompt",vec![],json!({"value":{"messages":[{"role":"system","content":system},{"role":"user","content":content}]}})),
        stage("sampler","sampler-select",vec![],json!({"temperature":1.0,"top_p":0.95,"top_k":20,"presence_penalty":0.0,"seed":42})),
        stage("chat","text-chat",vec![port("input"),port("sampler")],json!({"hf_dir":pe.model,"compute_dtype":"bf16","max_new_tokens":if edit {24000} else {16256},"page_tokens":1024,"max_pages":if edit {64} else {32},"disable_thinking":!pe.think,"enable_tools":false,"mtp":false})),
        stage("save","save-text",vec![port("chat")],json!({"path":output,"key":"text","append":false}))
    ]})
}
fn assemble_model(paths: &Paths, dest: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(&paths.model).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if name == "text_encoder" || name == "vae" {
            continue;
        }
        std::os::unix::fs::symlink(entry.path(), dest.join(name)).map_err(|e| e.to_string())?;
    }
    for (name, source) in [("text_encoder", &paths.llm), ("vae", &paths.vae)] {
        std::os::unix::fs::symlink(source, dest.join(name)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn adapter_modules(path: &str) -> Result<usize, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = [0u8; 8];
    f.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    let size = u64::from_le_bytes(bytes);
    if size > 16 * 1024 * 1024 {
        return Err("Invalid LoRA Safetensors header".into());
    }
    let mut header = vec![0; size as usize];
    f.read_exact(&mut header).map_err(|e| e.to_string())?;
    let data: Value = serde_json::from_slice(&header).map_err(|e| e.to_string())?;
    let count = data
        .as_object()
        .ok_or("Invalid LoRA header")?
        .keys()
        .filter(|key| {
            key.ends_with(".lora_A.weight")
                || key.ends_with(".lora_A.default.weight")
                || key.ends_with(".lora_down.weight")
        })
        .count();
    if count == 0 {
        return Err("LoRA contains no recognized adapter modules".into());
    }
    Ok(count)
}
fn progress(text: &str, steps: u32) -> Option<(u32, u32)> {
    if !text.contains("'denoise'") {
        return None;
    }
    let counts = text.rsplit_once('(')?.1.trim_end_matches(')');
    let (done, total) = counts.split_once('/')?;
    let done: u64 = done.parse().ok()?;
    let total: u64 = total.parse().ok()?;
    if total == 0 || done > total {
        return None;
    }
    Some(((done * u64::from(steps) / total) as u32, steps))
}

pub fn cached_paths(cli: String) -> Paths {
    let hub = std::env::var_os("HF_HUB_CACHE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_default()
                .join(".cache/huggingface/hub")
        });
    let hub = std::fs::canonicalize(&hub).unwrap_or(hub);
    cached_paths_in(&hub, cli)
}
fn cached_paths_in(hub: &std::path::Path, cli: String) -> Paths {
    let prepared = hub.join("vpipe-prepared");
    let q4 = prepared.join("Qwen-Image-2.1-Turbo-4bit");
    let q8 = prepared.join("Qwen-Image-2.1-Turbo-8bit");
    let pe = prepared.join("Qwen-Image-2.1-PE-T2I-4bit");
    let mut pose = String::new();
    let snapshots = hub.join("models--MIUProject--VNCCS_PoseStudio_QI2.1/snapshots");
    if let Ok(entries) = std::fs::read_dir(snapshots) {
        let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
        entries.sort_by_key(|e| e.path());
        for entry in entries {
            let path = entry.path().join("VNCCS_QI2_PoseStudioV1.1.safetensors");
            if path.is_file() {
                pose = path.to_string_lossy().into_owned();
            }
        }
    }
    Paths {
        lightning_lora: prepared
            .join("Qwen-Image-2.1-Lightning.safetensors")
            .to_string_lossy()
            .into_owned(),
        lightning_enabled: false,
        cli: cli.clone(),
        model: q4.to_string_lossy().into_owned(),
        model8: q8.to_string_lossy().into_owned(),
        quant_bits: 4,
        vae: q4.join("vae").to_string_lossy().into_owned(),
        llm: q4.join("text_encoder").to_string_lossy().into_owned(),
        vision: String::new(),
        turbo: true,
        pe_cli: cli,
        pe_model: pe.to_string_lossy().into_owned(),
        pe_system: pe.join("system_prompt.txt").to_string_lossy().into_owned(),
        pe_i2i_model: prepared
            .join("Qwen-Image-2.1-PE-I2I-4bit")
            .to_string_lossy()
            .into_owned(),
        pe_i2i_system: prepared
            .join("Qwen-Image-2.1-PE-I2I-4bit/system_prompt.txt")
            .to_string_lossy()
            .into_owned(),
        pose_enabled: false,
        pose_lora: pose,
        pose_strength: 0.7,
        anyangle_lora: discover_anyangle(hub),
        anyangle_enabled: false,
        anyangle_strength: 1.0,
    }
}

fn parse_enhancement(text: &str) -> Result<(String, String, String), String> {
    let answer = text
        .rsplit_once("</think>")
        .or_else(|| text.rsplit_once("<|__vpipe_think_end__|>"))
        .map(|(_, a)| a)
        .unwrap_or(text);
    let mut result = None;
    for (i, c) in answer.char_indices() {
        if c != '{' {
            continue;
        }
        if let Some(Ok(value)) = serde_json::Deserializer::from_str(&answer[i..])
            .into_iter::<Value>()
            .next()
        {
            if let Some(prompt) = value
                .get("rewritten_prompt")
                .or_else(|| value.get("rewrited_prompt"))
                .and_then(Value::as_str)
                .filter(|p| !p.trim().is_empty())
            {
                result = Some((
                    prompt.trim().to_string(),
                    value["wh_ratio"].as_str().unwrap_or("").to_string(),
                    value["ratio_follow"].as_str().unwrap_or("").to_string(),
                ));
            }
        }
    }
    if let Some((_, ratio, follow)) = &result {
        if !ratio.is_empty() && (!follow.is_empty() || ratio_size(ratio).is_none()) {
            return Err("Invalid enhancer aspect ratio fields".into());
        }
    }
    result.ok_or_else(|| {
        "Prompt enhancer did not return a valid rewritten_prompt JSON object; see render log".into()
    })
}
fn reference_index(follow: &str, count: usize) -> Result<usize, String> {
    follow
        .strip_prefix("<image")
        .and_then(|s| s.strip_suffix('>'))
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|i| *i > 0 && *i <= count)
        .map(|i| i - 1)
        .ok_or_else(|| "Enhancer ratio_follow names a nonexistent reference image".into())
}
fn finalize_reference_sizes(graph: &mut Value) -> Result<Vec<String>, String> {
    let stages = graph["stages"]
        .as_array_mut()
        .ok_or("Invalid image pipeline")?;
    let generation = stages
        .iter()
        .find(|s| s["id"] == "generate-image")
        .ok_or("Missing image generation stage")?;
    let width = generation["config"]["width"]
        .as_u64()
        .filter(|w| *w > 0)
        .ok_or("Missing output width")?;
    let height = generation["config"]["height"]
        .as_u64()
        .filter(|h| *h > 0)
        .ok_or("Missing output height")?;
    let mut sizes = Vec::new();
    for stage in stages.iter().filter(|s| s["type"] == "image-resample") {
        let load_id = stage["iports"][0]["src"]
            .as_str()
            .ok_or("Missing reference input")?;
        let load = stages
            .iter()
            .find(|s| s["id"] == load_id)
            .ok_or("Missing reference loader")?;
        let url = &load["config"]["url"];
        let path = url
            .as_str()
            .or_else(|| url[0].as_str())
            .ok_or("Missing reference path")?;
        let (w, h) = image::image_dimensions(path)
            .map_err(|e| format!("Cannot read reference {path}: {e}"))?;
        let (rw, rh) = edit_reference_size(w, h, width, height)?;
        sizes.push((
            stage["id"]
                .as_str()
                .ok_or("Missing resample id")?
                .to_owned(),
            w,
            h,
            rw,
            rh,
        ));
    }
    let mut messages = Vec::new();
    let mut area = 1024u64;
    for (id, w, h, rw, rh) in sizes {
        let stage = stages.iter_mut().find(|s| s["id"] == id).unwrap();
        stage["config"]["width"] = json!(rw);
        stage["config"]["height"] = json!(rh);
        area = area.max(u64::from(rw) * u64::from(rh));
        messages.push(format!(
            "[vpipe] reference {id}: {w}x{h} -> {rw}x{rh}, output {width}x{height}"
        ));
    }
    if !messages.is_empty() {
        let config = &mut stages
            .iter_mut()
            .find(|s| s["id"] == "model-config")
            .ok_or("Missing model config stage")?["config"];
        config["vl_long_edge"] = json!(0);
        config["vl_min_pixels"] = json!(1024);
        config["vl_pixel_budget"] = json!(area);
        config["vl_max_pixels"] = json!(area);
    }
    Ok(messages)
}

fn edit_reference_size(w: u32, h: u32, output_w: u64, output_h: u64) -> Result<(u32, u32), String> {
    if w == 0 || h == 0 || output_w == 0 || output_h == 0 {
        return Err("Reference and output dimensions must be positive".into());
    }
    let ratio = f64::from(w) / f64::from(h);
    let width = (output_w as f64 * output_h as f64 * ratio).sqrt();
    let align = |n: f64| -> Result<u32, String> {
        let n = (n / 32.0).round().max(1.0) * 32.0;
        if !n.is_finite() || n > u32::MAX as f64 {
            return Err("Calculated reference dimensions are too large".into());
        }
        Ok(n as u32)
    };
    Ok((align(width)?, align(width / ratio)?))
}

fn reference_size(w: u32, h: u32) -> (u32, u32) {
    let ratio = f64::from(w) / f64::from(h);
    let width = (1024.0 * 1024.0 * ratio).sqrt();
    (
        ((width / 32.0).round() as u32 * 32).clamp(256, 4096),
        ((width / ratio / 32.0).round() as u32 * 32).clamp(256, 4096),
    )
}
fn ratio_size(ratio: &str) -> Option<(u32, u32)> {
    let (a, b) = ratio.split_once(':')?;
    let ratio = a.trim().parse::<f64>().ok()? / b.trim().parse::<f64>().ok()?;
    if !ratio.is_finite() || ratio <= 0.0 {
        return None;
    }
    [
        (2048, 2048),
        (2400, 1792),
        (1792, 2400),
        (2528, 1696),
        (1696, 2528),
        (2752, 1536),
        (1536, 2752),
    ]
    .into_iter()
    .min_by(|(aw, ah), (bw, bh)| {
        ((f64::from(*aw) / f64::from(*ah) / ratio).ln().abs())
            .total_cmp(&((f64::from(*bw) / f64::from(*bh) / ratio).ln().abs()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn edit_references_follow_output_area_and_alignment() {
        for size in [128, 256, 512, 1024, 1536, 4096] {
            assert_eq!(
                edit_reference_size(1254, 1254, size, size).unwrap(),
                (size as u32, size as u32)
            );
        }
        assert_eq!(edit_reference_size(446, 724, 256, 256).unwrap(), (192, 320));
        assert_eq!(edit_reference_size(724, 446, 256, 256).unwrap(), (320, 192));
        assert_eq!(edit_reference_size(100, 100, 320, 800).unwrap(), (512, 512));
        assert_eq!(edit_reference_size(1, 8192, 128, 128).unwrap().0, 32);
        assert!(edit_reference_size(0, 100, 256, 256).is_err());
    }

    #[test]
    fn finalized_references_share_geometry_and_follow_final_canvas() {
        let root = std::env::temp_dir().join(format!("reference-sizing-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let refs = vec![root.join("pose.png"), root.join("avatar.png")];
        image::RgbaImage::new(446, 724).save(&refs[0]).unwrap();
        image::RgbaImage::new(1254, 1254).save(&refs[1]).unwrap();
        let r = request(&root, "vpipe", "edit");
        for inputs in [&refs[..1], &refs[..]] {
            let mut graph = image_pipeline(&r, inputs, &root.join("out.png"));
            for stage in graph["stages"].as_array_mut().unwrap() {
                if stage["id"] == "generate-image" {
                    stage["config"]["width"] = json!(256);
                    stage["config"]["height"] = json!(256);
                }
            }
            assert_eq!(
                finalize_reference_sizes(&mut graph).unwrap().len(),
                inputs.len()
            );
            let stages = graph["stages"].as_array().unwrap();
            let sizes: Vec<_> = stages
                .iter()
                .filter(|s| s["type"] == "image-resample")
                .collect();
            assert_eq!(sizes[0]["config"]["width"], 192);
            assert_eq!(sizes[0]["config"]["height"], 320);
            assert_eq!(sizes[0]["config"]["fit"], "stretch");
            let config = &stages.iter().find(|s| s["id"] == "model-config").unwrap()["config"];
            assert_eq!(config["vl_min_pixels"], 1024);
            assert!(config["vl_pixel_budget"].as_u64().unwrap() >= 192 * 320);
            if inputs.len() == 2 {
                assert_eq!(sizes[1]["config"]["width"], 256);
                let list = stages.iter().find(|s| s["id"] == "ref-list").unwrap();
                assert_eq!(
                    list["iports"],
                    json!([port("ref-resample-0"), port("ref-resample-1")])
                );
                assert_eq!(
                    stages.iter().find(|s| s["id"] == "vae-encode").unwrap()["iports"][2],
                    port("ref-list")
                );
                assert_eq!(
                    stages
                        .iter()
                        .find(|s| s["id"] == "diffusion-conditioner")
                        .unwrap()["iports"][6],
                    port("ref-list")
                );
            } else {
                assert_eq!(
                    stages.iter().find(|s| s["id"] == "vae-encode").unwrap()["iports"][0],
                    port("ref-resample")
                );
                assert_eq!(
                    stages
                        .iter()
                        .find(|s| s["id"] == "diffusion-conditioner")
                        .unwrap()["iports"][3],
                    port("ref-resample")
                );
            }
        }
        let mut graph = image_pipeline(&r, &refs[1..], &root.join("out.png"));
        for stage in graph["stages"].as_array_mut().unwrap() {
            if stage["id"] == "generate-image" {
                stage["config"]["width"] = json!(320);
                stage["config"]["height"] = json!(800);
            }
        }
        finalize_reference_sizes(&mut graph).unwrap();
        let stages = graph["stages"].as_array().unwrap();
        let config = &stages.iter().find(|s| s["id"] == "model-config").unwrap()["config"];
        assert_eq!(config["vl_pixel_budget"], 512 * 512);
        assert_eq!(config["vl_max_pixels"], 512 * 512);
        let resize = stages.iter().find(|s| s["id"] == "ref-resample").unwrap();
        assert_eq!(resize["config"]["width"], 512);
        assert_eq!(resize["config"]["height"], 512);
        let mut graph = image_pipeline(&r, &[root.join("missing.png")], &root.join("out.png"));
        assert!(
            finalize_reference_sizes(&mut graph)
                .unwrap_err()
                .contains("Cannot read reference")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    #[ignore = "real Metal inference with locally cached models and supplied desktop references"]
    async fn ui_sized_pose_edit_256() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let out = root.join("artifacts/vpipe-256-diagnosis/app-worker");
        let engine = Engine::new(out.clone(), &tokio::runtime::Handle::current());
        let mut r = request(
            &root,
            "",
            "Change the pose of <image2> to match <image1>. Keep her appearance and clothing.",
        );
        r.paths = cached_paths(
            root.join("vpipe/build/apps/vpipe/vpipe")
                .to_string_lossy()
                .into_owned(),
        );
        r.paths.quant_bits = 8;
        r.paths.pose_enabled = true;
        r.paths.pose_strength = 0.7;
        r.settings.width = Some(256);
        r.settings.height = Some(256);
        r.settings.steps = 8;
        r.settings.cfg = 1.0;
        r.settings.seed = 42;
        r.settings.enhance = false;
        r.references = [
            "/Volumes/Data/Users/paul/Desktop/scene.png",
            "/Volumes/Data/Users/paul/Desktop/1.png",
        ]
        .iter()
        .map(|p| Reference {
            png: STANDARD.encode(std::fs::read(p).unwrap()),
        })
        .collect();
        let id = engine.submit(r).unwrap()["id"].as_str().unwrap().to_owned();
        let job = tokio::time::timeout(std::time::Duration::from_secs(600), async {
            loop {
                let snapshot = engine.snapshot();
                let job = snapshot["jobs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|j| j["id"] == id)
                    .unwrap()
                    .clone();
                if matches!(
                    job["state"].as_str(),
                    Some("completed" | "failed" | "cancelled")
                ) {
                    break job;
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(job["state"], "completed", "{job}");
        assert_eq!(
            image::image_dimensions(out.join(&id).join("output.png")).unwrap(),
            (256, 256)
        );
        println!(
            "Validated output: {}",
            out.join(id).join("output.png").display()
        );
    }

    fn request(root: &std::path::Path, cli: &str, prompt: &str) -> Request {
        let mut paths = cached_paths_in(root, cli.into());
        paths.model = root.join("model").to_string_lossy().into_owned();
        paths.model8 = root.join("model8").to_string_lossy().into_owned();
        paths.llm = root.join("encoder").to_string_lossy().into_owned();
        paths.vae = root.join("vae").to_string_lossy().into_owned();
        paths.pose_enabled = false;
    paths.anyangle_enabled = false;
        Request {
            loras: None,
            model_id: None,
            auto_ratio: false,
            session: "test".into(),
            paths,
            references: vec![],
            settings: Settings {
                prompt: prompt.into(),
                width: Some(1024),
                height: Some(1024),
                steps: 8,
                cfg: 1.0,
                seed: 42,
                enhance: false,
                think: false,
                transparent: false,
                device: "auto".into(),
                ratio: None,
            },
        }
    }
    fn setup(root: &std::path::Path) {
        for name in ["model/transformer", "model8/transformer", "encoder", "vae"] {
            let dir = root.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("config.json"),
                if name.starts_with("model8") {
                    r#"{"_class_name":"QwenImage21Transformer2DModel","quantization":{"bits":8}}"#
                } else if name.starts_with("model/") {
                    r#"{"_class_name":"QwenImage21Transformer2DModel","quantization":{"bits":4}}"#
                } else {
                    "{}"
                },
            )
            .unwrap();
        }
        for name in ["model", "model8"] {
            std::fs::write(
                root.join(name).join("model_index.json"),
                r#"{"sample_sigmas":[1.0,0.9,0.8,0.7,0.6,0.5,0.4,0.3]}"#,
            )
            .unwrap();
        }
    }
    #[test]
    fn graph_preserves_text_and_reference_order_and_uses_runtime_lora() {
        let root = PathBuf::from("/tmp/fixture");
        let mut r = request(&root, "vpipe", "quote ' $(touch injected) <image1>");
        let refs = vec![root.join("one.png"), root.join("two.png")];
        r.paths.pose_enabled = true;
        r.paths.pose_lora = "/tmp/pose.safetensors".into();
        let graph = image_pipeline(&r, &refs, &root.join("output.png"));
        assert_eq!(graph["stages"][1]["config"]["text"], r.settings.prompt);
        assert_eq!(graph["stages"][2]["config"]["lora2_scale"], json!(0.7f32));
        assert_eq!(graph["stages"][3]["config"]["url"], json!(refs[0]));
        assert_eq!(graph["stages"][5]["config"]["url"], json!(refs[1]));
        let stages = graph["stages"].as_array().unwrap();
        let list = stages.iter().find(|s| s["id"] == "ref-list").unwrap();
        assert_eq!(
            list["iports"],
            json!([port("ref-resample-0"), port("ref-resample-1")])
        );
        let conditioner = stages
            .iter()
            .find(|s| s["id"] == "diffusion-conditioner")
            .unwrap();
        assert_eq!(conditioner["iports"][6], port("ref-list"));
        let generation = stages.iter().find(|s| s["id"] == "generate-image").unwrap();
        assert_eq!(
            generation["iports"][8],
            json!({"src":"vae-encode","oport":1})
        );
        assert!(
            image_pipeline(&r, &[], &root.join("out.png"))["stages"][2]["config"]
                .get("lora")
                .is_none()
        );
        assert!(graph.to_string().contains("1024"));
    }
    #[test]
    fn selection_request_resolves_paths_and_validates_adapter_rows() {
        let fixture = request(std::path::Path::new("/tmp/fixture"), "vpipe", "test");
        let mut r: Request = serde_json::from_value(json!({"session":"test", "settings":fixture.settings, "references":[], "model_id":"base-8", "loras":[{"id":"lightning","strength":1.0},{"id":"pose","strength":0.7}]})).unwrap();
        assert_eq!(r.paths.cli, default_cli());
        r.paths.turbo = false;
        let adapters = r.loras.unwrap();
        apply_adapter_selection(&mut r.paths, &adapters).unwrap();
        assert!(r.paths.lightning_enabled && r.paths.pose_enabled);
        apply_adapter_selection(&mut r.paths, &[]).unwrap();
        assert!(!r.paths.lightning_enabled && !r.paths.pose_enabled);
        r.paths.turbo = true;
        assert!(apply_adapter_selection(&mut r.paths, &adapters).is_err());
        let duplicate = vec![
            AdapterSelection {
                id: "pose".into(),
                strength: 0.7
            };
            2
        ];
        assert!(apply_adapter_selection(&mut r.paths, &duplicate).is_err());
        assert!(
            apply_adapter_selection(
                &mut r.paths,
                &[AdapterSelection {
                    id: "pose".into(),
                    strength: 2.1
                }]
            )
            .is_err()
        );
    }
    #[test]
    fn lightning_and_pose_have_independent_slots_and_four_steps() {
        let root = PathBuf::from("/tmp/fixture");
        let mut r = request(&root, "vpipe", "test");
        r.paths.turbo = false;
        r.paths.lightning_enabled = true;
        r.paths.lightning_lora = "/tmp/lightning.safetensors".into();
        r.paths.pose_enabled = true;
        r.paths.pose_lora = "/tmp/pose.safetensors".into();
        r.settings.steps = 4;
        r.loras = Some(vec![
            AdapterSelection {
                id: "lightning".into(),
                strength: 0.8,
            },
            AdapterSelection {
                id: "pose".into(),
                strength: 0.7,
            },
        ]);
        let graph = image_pipeline(&r, &[root.join("ref.png")], &root.join("out.png"));
        let cfg = &graph["stages"][2]["config"];
        assert_eq!(cfg["lora"], r.paths.lightning_lora);
        assert_eq!(cfg["lora2"], r.paths.pose_lora);
        assert_eq!(cfg["lora_scale"], json!(0.8f32));
        assert_eq!(cfg["sigmas"], json!([1.0, 0.75, 0.5, 0.25]));
        assert_eq!(cfg["shift_terminal"], 0.0);
        assert_eq!(cfg["use_kv_cache"], false);
        assert_eq!(
            progress("50% of 'denoise' completed (64/128)", 4),
            Some((2, 4))
        );
        let text = image_pipeline(&r, &[], &root.join("out.png"));
        assert!(text["stages"][2]["config"].get("lora2").is_none());
        let generate = text["stages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "generate-image")
            .unwrap();
        assert_eq!(generate["config"]["steps"], 4);
    }
    #[test]
    fn missing_shards_are_not_installed() {
        let root = std::env::temp_dir().join(format!("catalog-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("config.json"), "{}").unwrap();
        std::fs::write(
            root.join("model.safetensors.index.json"),
            r#"{"weight_map":{"weight":"one.safetensors"}}"#,
        )
        .unwrap();
        assert!(!component_installed(&root));
        std::fs::write(root.join("one.safetensors"), "fixture").unwrap();
        assert!(component_installed(&root));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn base_allows_adjustable_steps_and_missing_lightning_is_rejected() {
        let root = std::env::temp_dir().join(format!("base-{}", Uuid::new_v4()));
        setup(&root);
        let mut r = request(&root, "/usr/bin/true", "test");
        r.paths.turbo = false;
        r.settings.steps = 40;
        assert!(validate(&r).is_ok());
        r.paths.lightning_enabled = true;
        assert!(validate(&r).unwrap_err().contains("Lightning"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn progress_tracks_vpipe_blocks_without_confusing_weight_loading() {
        assert_eq!(
            progress("50% of 'denoise' completed at 12:34 (128/256)", 8),
            Some((4, 8))
        );
        assert_eq!(
            progress("50% of 'load weights' completed at 12:34 (128/256)", 8),
            None
        );
        assert_eq!(
            progress("'denoise' ended at 12:34, last reported 25% (64/256)", 8),
            Some((2, 8))
        );
    }
    #[test]
    fn enhancement_keeps_official_system_and_thinking_control() {
        let pe = Enhancement {
            cli: "vpipe".into(),
            model: "/pe".into(),
            system: "/system".into(),
            prompt: "mug".into(),
            think: true,
            auto_ratio: false,
            references: vec![],
        };
        let p = enhancement_pipeline(&pe, "official instructions", std::path::Path::new("/out"));
        assert_eq!(
            p["stages"][0]["config"]["value"]["messages"][0]["content"],
            "official instructions"
        );
        assert_eq!(p["stages"][2]["config"]["disable_thinking"], false);
        assert_eq!(p["stages"][2]["config"]["mtp"], false);
        assert_eq!(
            parse_enhancement(
                "<think>example</think>{\"rewritten_prompt\":\"A {SIGN}\",\"wh_ratio\":\"1:1\"}"
            )
            .unwrap()
            .0,
            "A {SIGN}"
        );
        assert!(parse_enhancement("malformed").is_err());
    }
    #[test]
    fn edit_enhancement_preserves_images_and_canvas_contract() {
        let pe = Enhancement {
            cli: "vpipe".into(),
            model: "/pe-i2i".into(),
            system: "/system".into(),
            prompt: "Put <image1> into <image2>".into(),
            think: false,
            auto_ratio: true,
            references: vec!["/first.png".into(), "/second.png".into()],
        };
        let graph = enhancement_pipeline(&pe, "edit instructions", std::path::Path::new("/reply"));
        let content = graph["stages"][0]["config"]["value"]["messages"][1]["content"]
            .as_str()
            .unwrap();
        assert!(content.find("/first.png").unwrap() < content.find("/second.png").unwrap());
        assert!(content.ends_with("Put <image1> into <image2>"));
        assert_eq!(graph["stages"][2]["config"]["max_new_tokens"], 24000);
        assert_eq!(graph["stages"][2]["config"]["disable_thinking"], true);
        let result = parse_enhancement(
            r#"{"rewritten_prompt":"Edit sky","wh_ratio":"","ratio_follow":"<image2>"}"#,
        )
        .unwrap();
        assert_eq!(reference_index(&result.2, 2).unwrap(), 1);
        assert_eq!(reference_size(1024, 1024), (1024, 1024));
        assert_eq!(reference_size(2048, 1024), (1440, 736));
        assert_eq!(reference_size(1024, 2048), (736, 1440));
        for bad in ["<image0>", "<image3>", "image1", "<image-1>"] {
            assert!(reference_index(bad, 2).is_err());
        }
        assert!(
            parse_enhancement(
                r#"{"rewritten_prompt":"Edit","wh_ratio":"1:1","ratio_follow":"<image1>"}"#
            )
            .is_err()
        );
        assert!(parse_enhancement(r#"{"rewritten_prompt":"Edit","wh_ratio":"invalid"}"#).is_err());
        let mut value = serde_json::to_value(cached_paths_in(
            std::path::Path::new("/cache"),
            "vpipe".into(),
        ))
        .unwrap();
        value.as_object_mut().unwrap().remove("pe_i2i_model");
        value.as_object_mut().unwrap().remove("pe_i2i_system");
        let old: Paths = serde_json::from_value(value).unwrap();
        assert!(old.pe_i2i_model.is_empty());
    }

    #[test]
    fn defaults_choose_four_bit_and_keep_both_models() {
        let paths = cached_paths_in(std::path::Path::new("/cache"), "vpipe".into());
        assert_eq!(paths.quant_bits, 4);
        assert!(paths.model.ends_with("Turbo-4bit"));
        assert!(paths.model8.ends_with("Turbo-8bit"));
        assert!(!serde_json::to_string(&paths).unwrap().contains("gguf"));
    }
    #[tokio::test]
    async fn queue_cancellation_failure_and_enhancement_recovery() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("vpipe-engine-{}", Uuid::new_v4()));
        setup(&root);
        image::RgbaImage::new(1024, 1024)
            .save(root.join("source.png"))
            .unwrap();
        let cli = root.join("fixture-vpipe");
        let script = r#"#!/usr/bin/env python3
import json,sys,time,shutil,pathlib
p=json.load(open(sys.argv[sys.argv.index('--launch')+1])); stages=p['stages']; prompt=stages[1]['config'].get('text','')
if p['id']=='studio-enhance':
 prompt=stages[0]['config']['value']['messages'][-1]['content']
 if prompt=='slow': time.sleep(60)
 if '<|__vpipe_fs_im_start__|>' in prompt:
  assert pathlib.Path(prompt.split('<|__vpipe_fs_im_start__|>')[1].split('<|__vpipe_fs_im_end__|>')[0]).is_file()
  if prompt.endswith('drop'): print('dropping image attachment: vision encode failed',file=sys.stderr)
 pathlib.Path(stages[-1]['config']['path']).write_text('malformed' if prompt=='bad' else json.dumps({'rewritten_prompt':'Enhanced mug','wh_ratio':'1:1'}))
 sys.exit(0)
if prompt=='slow': time.sleep(60)
if prompt=='fail': sys.exit(7)
if prompt!='noout': shutil.copyfile(pathlib.Path(__file__).parent/'source.png',stages[-1]['config']['path'])
"#;
        std::fs::write(&cli, script).unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        let engine = Engine::new(root.join("renders"), &tokio::runtime::Handle::current());
        let submit = |r| {
            engine.submit(r).unwrap()["id"]
                .as_str()
                .unwrap()
                .to_string()
        };
        let req = |p: &str| request(&root, &cli.to_string_lossy(), p);
        let active = submit(req("slow"));
        wait(&engine, &active, "running").await;
        let queued = submit(req("queued"));
        engine.cancel(&queued).unwrap();
        engine.cancel(&active).unwrap();
        wait(&engine, &active, "cancelled").await;
        for prompt in ["fail", "noout"] {
            let id = submit(req(prompt));
            wait(&engine, &id, "failed").await;
        }
        let id = submit(req("success"));
        wait(&engine, &id, "completed").await;
        let mut eight = req("eight");
        eight.paths.quant_bits = 8;
        let id = submit(eight);
        wait(&engine, &id, "completed").await;
        let transformer =
            std::fs::read_link(root.join("renders").join(&id).join("model/transformer")).unwrap();
        assert_eq!(
            transformer,
            std::fs::canonicalize(root.join("model8/transformer")).unwrap()
        );
        let mut r = req("enhance");
        r.settings.enhance = true;
        r.paths.pe_cli = cli.to_string_lossy().into_owned();
        r.paths.pe_model = root.join("encoder").to_string_lossy().into_owned();
        r.paths.pe_system = root.join("system.txt").to_string_lossy().into_owned();
        std::fs::write(&r.paths.pe_system, "instructions").unwrap();
        let id = submit(r);
        wait(&engine, &id, "completed").await;
        assert_eq!(
            engine.snapshot()["jobs"]
                .as_array()
                .unwrap()
                .iter()
                .find(|j| j["id"] == id)
                .unwrap()["enhanced_prompt"],
            "Enhanced mug"
        );
        for prompt in ["edit", "drop"] {
            let mut r = req(prompt);
            r.settings.enhance = true;
            r.paths.pe_cli = cli.to_string_lossy().into_owned();
            r.paths.pe_i2i_model = root.join("encoder").to_string_lossy().into_owned();
            r.paths.pe_i2i_system = root.join("system.txt").to_string_lossy().into_owned();
            r.references = vec![Reference {
                png: STANDARD.encode(std::fs::read(root.join("source.png")).unwrap()),
            }];
            let id = submit(r);
            wait(
                &engine,
                &id,
                if prompt == "drop" {
                    "failed"
                } else {
                    "completed"
                },
            )
            .await;
            if prompt == "drop" {
                assert!(!root.join("renders").join(&id).join("output.png").exists());
            }
        }
        for prompt in ["bad", "slow"] {
            let mut r = req(prompt);
            r.settings.enhance = true;
            r.paths.pe_cli = cli.to_string_lossy().into_owned();
            r.paths.pe_model = root.join("encoder").to_string_lossy().into_owned();
            r.paths.pe_system = root.join("system.txt").to_string_lossy().into_owned();
            let id = submit(r);
            if prompt == "slow" {
                tokio::time::timeout(std::time::Duration::from_secs(5), async {
                    loop {
                        if engine.snapshot()["jobs"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|j| j["id"] == id && j["stage"] == "enhance")
                        {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    }
                })
                .await
                .unwrap();
                engine.cancel(&id).unwrap();
                wait(&engine, &id, "cancelled").await;
            } else {
                wait(&engine, &id, "failed").await;
            }
        }
        let recovered = submit(req("success"));
        wait(&engine, &recovered, "completed").await;
        engine.shutdown();
        std::fs::remove_dir_all(root).unwrap();
    }
    async fn wait(engine: &Engine, id: &str, state: &str) {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                if engine.snapshot()["jobs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|j| j["id"] == id && j["state"] == state)
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("Expected {state}: {}", engine.snapshot()));
    }
}

#[derive(Serialize)]
pub struct CatalogModel {
    pub id: String,
    pub turbo: bool,
    pub bits: u8,
    pub available: bool,
    pub pose_available: bool,
    pub anyangle_available: bool,
    pub lightning_available: bool,
    #[serde(skip)]
    pub path: String,
}
pub fn model_catalog() -> Vec<CatalogModel> {
    let defaults = cached_paths(String::new());
    let prepared = PathBuf::from(&defaults.model)
        .parent()
        .unwrap()
        .to_path_buf();
    [true, false]
        .into_iter()
        .flat_map(|turbo| {
            let defaults = &defaults;
            let prepared = &prepared;
            [4, 8].into_iter().map(move |bits| {
                let path = prepared.join(format!(
                    "Qwen-Image-2.1{}-{bits}bit",
                    if turbo { "-Turbo" } else { "" }
                ));
                CatalogModel {
                    id: format!("{}-{bits}", if turbo { "turbo" } else { "base" }),
                    turbo,
                    bits,
                    available: component_installed(&path.join("transformer"))
                        && component_installed(&path.join("text_encoder"))
                        && component_installed(&path.join("vae"))
                        && path.join("model_index.json").is_file(),
                    anyangle_available: PathBuf::from(&defaults.anyangle_lora).is_file(),
                    pose_available: PathBuf::from(&defaults.pose_lora).is_file(),
                    lightning_available: PathBuf::from(&defaults.lightning_lora).is_file(),
                    path: path.to_string_lossy().into_owned(),
                }
            })
        })
        .collect()
}

pub fn default_cli() -> String {
    let bundled = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.join("vpipe")));
    bundled
        .filter(|p| p.is_file())
        .unwrap_or_else(|| {
            PathBuf::from(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/vpipe/build/apps/vpipe/vpipe"
            ))
        })
        .to_string_lossy()
        .into_owned()
}
fn component_installed(path: &std::path::Path) -> bool {
    if !path.join("config.json").is_file() {
        return false;
    }
    for index in [
        "model.safetensors.index.json",
        "diffusion_pytorch_model.safetensors.index.json",
    ] {
        if let Ok(bytes) = std::fs::read(path.join(index)) {
            if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                return value["weight_map"].as_object().is_some_and(|m| {
                    !m.is_empty()
                        && m.values()
                            .all(|v| v.as_str().is_some_and(|name| path.join(name).is_file()))
                });
            }
        }
    }
    ["model.safetensors", "diffusion_pytorch_model.safetensors"]
        .iter()
        .any(|n| path.join(n).is_file())
}

fn default_paths() -> Paths {
    cached_paths(default_cli())
}

fn apply_adapter_selection(paths: &mut Paths, adapters: &[AdapterSelection]) -> Result<(), String> {
    paths.lightning_enabled = false;
    paths.pose_enabled = false;
    paths.anyangle_enabled = false;
    let mut seen = std::collections::HashSet::new();
    for adapter in adapters {
        if !seen.insert(&adapter.id) {
            return Err("Each LoRA may be added once".into());
        }
        if !adapter.strength.is_finite() || !(0.0..=2.0).contains(&adapter.strength) {
            return Err("LoRA strength must be between 0 and 2".into());
        }
        match adapter.id.as_str() {
            "lightning" if !paths.turbo => paths.lightning_enabled = true,
            "anyangle" => { paths.anyangle_enabled = true; paths.anyangle_strength = adapter.strength; }
            "pose" => {
                paths.pose_enabled = true;
                paths.pose_strength = adapter.strength;
            }
            _ => return Err("LoRA is unavailable for this model".into()),
        }
    }
    Ok(())
}

fn discover_anyangle(hub: &std::path::Path) -> String {
    let repo = hub.join("models--lilylilith--QI_2.1_AnyAngle");
    if let Ok(revision) = std::fs::read_to_string(repo.join("refs/main")) {
        let path = repo.join("snapshots").join(revision.trim()).join("QI2.1_AnyAngle.safetensors");
        if path.is_file() { return path.to_string_lossy().into_owned(); }
    }
    let mut paths: Vec<_> = std::fs::read_dir(repo.join("snapshots")).into_iter().flatten().filter_map(Result::ok).map(|e| e.path().join("QI2.1_AnyAngle.safetensors")).filter(|p| p.is_file()).collect();
    paths.sort();
    paths.last().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

#[cfg(test)]
mod anyangle_cfg_tests {
    use super::*;
    #[test]
    fn old_settings_default_cfg_and_invalid_cfg_is_rejected() {
        let settings: Settings = serde_json::from_value(json!({"prompt":"cup","width":256,"height":256,"steps":8,"seed":42,"enhance":false,"think":false,"transparent":false,"device":"mps","ratio":null})).unwrap();
        assert_eq!(settings.cfg, 1.0);
        let mut request = Request { settings, paths: cached_paths_in(std::path::Path::new("/missing"), String::new()), loras: None, model_id: None, auto_ratio: false, session: "test".into(), references: vec![] };
        for cfg in [0.9, 10.1, f32::NAN] { request.settings.cfg = cfg; assert!(validate(&request).unwrap_err().contains("CFG")); }
        request.settings.cfg = 3.0;
        request.paths.anyangle_enabled = true;
        assert!(validate(&request).unwrap_err().contains("AnyAngle LoRA is not installed"));
    }
    #[test]
    fn cfg_pipeline_wires_negative_for_all_reference_counts_and_stacks_adapters() {
        let settings: Settings = serde_json::from_value(json!({"prompt":"cup","width":256,"height":256,"steps":8,"cfg":2.5,"seed":42,"enhance":false,"think":false,"transparent":false,"device":"mps","ratio":null})).unwrap();
        let mut request = Request { settings, paths: cached_paths_in(std::path::Path::new("/missing"), String::new()), loras: None, model_id: None, auto_ratio: false, session: "test".into(), references: vec![] };
        for count in 0..=2 {
            let refs = vec![PathBuf::from("ref.png"); count];
            let p = image_pipeline(&request, &refs, std::path::Path::new("out.png"));
            let stage = |id| p["stages"].as_array().unwrap().iter().find(|s| s["id"] == id).unwrap();
            assert_eq!(stage("generate-image")["config"]["guidance_scale"], 2.5);
            assert_eq!(stage("generate-image")["iports"][1], json!({"src":"diffusion-conditioner","oport":1}));
            assert_eq!(stage("diffusion-conditioner")["config"]["grounded_negative"], true);
        }
        request.settings.cfg = 1.0;
        let p = image_pipeline(&request, &[], std::path::Path::new("out.png"));
        let generation = p["stages"].as_array().unwrap().iter().find(|s| s["id"] == "generate-image").unwrap();
        assert_eq!(generation["iports"][1]["src"], "");
        request.paths.turbo = false;
        apply_adapter_selection(&mut request.paths, &[AdapterSelection {id:"lightning".into(),strength:1.0}, AdapterSelection {id:"pose".into(),strength:0.7}, AdapterSelection {id:"anyangle".into(),strength:1.2}]).unwrap();
        let p = image_pipeline(&request, &[PathBuf::from("ref.png")], std::path::Path::new("out.png"));
        let model = p["stages"].as_array().unwrap().iter().find(|s| s["id"] == "model-config").unwrap();
        assert!(model["config"].get("lora").is_some());
        assert!(model["config"].get("lora2").is_some());
        assert_eq!(model["config"]["lora3_scale"], json!(1.2f32));
        let generation = p["stages"].as_array().unwrap().iter().find(|s| s["id"] == "generate-image").unwrap();
        assert_eq!(generation["config"]["guidance_scale"], 3.0);
        assert!(apply_adapter_selection(&mut request.paths, &[AdapterSelection {id:"anyangle".into(),strength:2.1}]).is_err());
    }
    #[test]
    fn discovers_anyangle_and_prefers_current_revision() {
        let root = std::env::temp_dir().join(format!("anyangle-discovery-{}", Uuid::new_v4()));
        assert!(discover_anyangle(&root).is_empty());
        let repo = root.join("models--lilylilith--QI_2.1_AnyAngle");
        for revision in ["a", "z"] {
            let dir = repo.join("snapshots").join(revision);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("QI2.1_AnyAngle.safetensors"), b"test").unwrap();
        }
        std::fs::create_dir_all(repo.join("refs")).unwrap();
        std::fs::write(repo.join("refs/main"), "a\n").unwrap();
        assert!(discover_anyangle(&root).ends_with("a/QI2.1_AnyAngle.safetensors"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
