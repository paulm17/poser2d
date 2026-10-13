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
#[derive(Deserialize)]
pub struct Request {
    #[serde(default)]
    pub auto_ratio: bool,
    pub session: String,
    pub settings: Settings,
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
}
struct Work {
    enhancement: Option<Enhancement>,
    references: Vec<Reference>,
    id: String,
    args: Vec<String>,
    pose_modules: usize,
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
        request.settings.steps = 8;
        request.paths.turbo = true;
        if request.paths.quant_bits == 8 {
            request.paths.model = request.paths.model8.clone();
        }
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
            return Err("Select an existing vpipe executable in Paths".into());
        }
        let pose_modules = if request.paths.pose_enabled && !request.references.is_empty() {
            adapter_modules(&request.paths.pose_lora)?
        } else {
            0
        };
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
                Ok(Some((prompt, ratio))) => {
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
                        if let Some((w, h)) = ratio_size(&ratio) {
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
                if work.pose_modules > 0 {
                    let log =
                        std::fs::read_to_string(work.dir.join("render.log")).unwrap_or_default();
                    let expected = format!("-- {} modules at scale", work.pose_modules);
                    if !log.contains(&expected) || log.contains("SKIPPED (shape mismatch)") {
                        self.finish(
                            &work.id,
                            "failed",
                            Some(format!(
                                "PoseStudio did not bind all {} adapter modules; see render log",
                                work.pose_modules
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
    ) -> Result<Option<(String, String)>, String> {
        self.log(
            id,
            "[enhance] Loading PE-T2I. Image generation waits until this process exits.",
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
        let logs = tokio::spawn(async move { b.read(stderr, &job).await });
        let status = tokio::select! { biased;
            _ = async { if !*cancel.borrow() { let _ = cancel.changed().await; } } => { if let Some(pid) = child.id() { unsafe { libc::kill(-(pid as i32), libc::SIGKILL); } } let _ = child.wait().await; None },
            status = child.wait() => Some(status.map_err(|e| e.to_string())?),
        };
        let _stdout = output.await.map_err(|e| e.to_string())?;
        let _ = logs.await;
        if status.is_none() || *cancel.borrow() {
            return Ok(None);
        }
        if !status.unwrap().success() {
            return Err("Prompt enhancer failed; see render log".into());
        }
        let text = std::fs::read_to_string(dir.join("enhanced.txt"))
            .map_err(|e| format!("Enhancer produced no reply: {e}"))?;
        let parsed = parse_enhancement(&text)?;
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
            if let Some((step, total)) = progress(&text) {
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
            return Err("Select a prepared PE-T2I Safetensors model directory in Paths".into());
        }
        if !r.references.is_empty() {
            return Err("Prompt enhancement currently supports text-to-image only".into());
        }
        for (label, path) in [
            ("vpipe enhancer executable", &r.paths.pe_cli),
            ("PE-T2I weights", &r.paths.pe_model),
            ("PE-T2I system prompt", &r.paths.pe_system),
        ] {
            if !PathBuf::from(path).exists() {
                return Err(format!("Select existing {label} in Paths"));
            }
        }
    }
    if s.steps != 8 {
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
                "Select an existing {name} Safetensors model directory in Paths"
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
            .map_err(|e| format!("Turbo sampling configuration is missing: {e}"))?,
    )
    .map_err(|e| e.to_string())?;
    if config["_class_name"] != "QwenImage21Transformer2DModel"
        || index["sample_sigmas"].as_array().map(Vec::len) != Some(8)
    {
        return Err("Select a Qwen-Image-2.1-Turbo pipeline with its official eight-step sampling configuration".into());
    }
    if config["quantization"]["bits"].as_u64() != Some(r.paths.quant_bits as u64) {
        return Err(format!(
            "Selected model must be a prepared {}-bit Turbo transformer",
            r.paths.quant_bits
        ));
    }
    if r.paths.pose_enabled && !r.references.is_empty() {
        let path = PathBuf::from(&r.paths.pose_lora);
        if !path.is_file() {
            return Err("Select an existing PoseStudio LoRA in Paths or disable it".into());
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
    let mut cfg = json!({"use_kv_cache":true});
    if r.paths.pose_enabled && !refs.is_empty() {
        cfg["lora"] = json!(r.paths.pose_lora);
        cfg["lora_scale"] = json!(r.paths.pose_strength);
    }
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
    if !refs.is_empty() {
        stages.push(stage("load-ref", "load-image", vec![], json!({"url":refs})));
        stages.push(stage(
            "ref-resample",
            "image-resample",
            vec![port("load-ref")],
            json!({"width":1024,"height":1024,"fit":"pad","algorithm":"lanczos"}),
        ));
        stages.push(stage(
            "vae-encode",
            "vae-encode",
            vec![port("ref-resample"), port("model-select")],
            json!({"unload_when_idle":"always"}),
        ));
    }
    let ref_port = if refs.is_empty() { "" } else { "ref-resample" };
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
        ],
        json!({"unload_when_idle":"always"}),
    ));
    stages.push(stage("generate-image", "generate-image", vec![port("diffusion-conditioner"),port(""),port("model-select"),port(""),port(""),port(if refs.is_empty(){""}else{"vae-encode"}),port(""),port("model-config")], json!({"width":r.settings.width,"height":r.settings.height,"seed":r.settings.seed,"unload_when_idle":"always"})));
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
    json!({"id":"studio-enhance","subpipelines":[],"stages":[
        stage("input","text-prompt",vec![],json!({"value":{"messages":[{"role":"system","content":system},{"role":"user","content":pe.prompt}]}})),
        stage("sampler","sampler-select",vec![],json!({"temperature":1.0,"top_p":0.95,"top_k":20,"seed":42})),
        stage("chat","text-chat",vec![port("input"),port("sampler")],json!({"hf_dir":pe.model,"compute_dtype":"bf16","max_new_tokens":16256,"page_tokens":1024,"max_pages":32,"disable_thinking":!pe.think,"enable_tools":false,"mtp":false})),
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
        return Err("PoseStudio contains no recognized adapter modules".into());
    }
    Ok(count)
}
fn progress(text: &str) -> Option<(u32, u32)> {
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
    Some(((done * 8 / total) as u32, 8))
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
        pose_enabled: !pose.is_empty(),
        pose_lora: pose,
        pose_strength: 0.7,
    }
}

fn parse_enhancement(text: &str) -> Result<(String, String), String> {
    let answer = text.rsplit_once("</think>").map(|(_, a)| a).unwrap_or(text);
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
                ));
            }
        }
    }
    result.ok_or_else(|| {
        "Prompt enhancer did not return a valid rewritten_prompt JSON object; see render log".into()
    })
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
    fn request(root: &std::path::Path, cli: &str, prompt: &str) -> Request {
        let mut paths = cached_paths_in(root, cli.into());
        paths.model = root.join("model").to_string_lossy().into_owned();
        paths.model8 = root.join("model8").to_string_lossy().into_owned();
        paths.llm = root.join("encoder").to_string_lossy().into_owned();
        paths.vae = root.join("vae").to_string_lossy().into_owned();
        paths.pose_enabled = false;
        Request {
            auto_ratio: false,
            session: "test".into(),
            paths,
            references: vec![],
            settings: Settings {
                prompt: prompt.into(),
                width: Some(1024),
                height: Some(1024),
                steps: 8,
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
        assert_eq!(graph["stages"][2]["config"]["lora_scale"], json!(0.7f32));
        assert_eq!(graph["stages"][3]["config"]["url"], json!(refs));
        assert!(
            image_pipeline(&r, &[], &root.join("out.png"))["stages"][2]["config"]
                .get("lora")
                .is_none()
        );
        assert!(graph.to_string().contains("1024"));
    }
    #[test]
    fn progress_tracks_vpipe_blocks_without_confusing_weight_loading() {
        assert_eq!(
            progress("50% of 'denoise' completed at 12:34 (128/256)"),
            Some((4, 8))
        );
        assert_eq!(
            progress("50% of 'load weights' completed at 12:34 (128/256)"),
            None
        );
        assert_eq!(
            progress("'denoise' ended at 12:34, last reported 25% (64/256)"),
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
