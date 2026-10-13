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
    pub vae: String,
    pub llm: String,
    pub vision: String,
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
        if !request.references.is_empty() {
            request.paths.vision = std::fs::canonicalize(&request.paths.vision)
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
            for path in [&mut request.paths.pe_cli, &mut request.paths.pe_system] {
                *path = std::fs::canonicalize(&*path)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .into_owned();
            }
        }
        let cli = PathBuf::from(&request.paths.cli);
        if !cli.is_file() {
            return Err("Select an existing sd-cli executable in Paths".into());
        }
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
            auto_ratio: request.auto_ratio,
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
            references: request.references,
            id: id.clone(),
            args,
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
            let _ = std::fs::remove_dir_all(&work.dir);
            return;
        }

        if let Some(enhancement) = &work.enhancement {
            self.update(&work.id, |j| j.stage = "enhance".into());
            match self.enhance(enhancement, &work.id, &mut cancel).await {
                Ok(Some((prompt, ratio))) => {
                    let p = work.args.iter().position(|a| a == "-p").unwrap();
                    // Preserve the transparency instructions applied by arguments().
                    work.args[p + 1] = if self
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
                    };
                    if enhancement.auto_ratio {
                        if let Some((w, h)) = ratio_size(&ratio) {
                            for (flag, value) in [("--width", w), ("--height", h)] {
                                let i = work.args.iter().position(|a| a == flag).unwrap();
                                work.args[i + 1] = value.to_string();
                            }
                        }
                    }
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
                    let _ = std::fs::remove_dir_all(&work.dir);
                    return;
                }
            }
        }
        if *cancel.borrow() {
            self.finish(&work.id, "cancelled", None);
            return;
        }

        let mut command = Command::new(&work.cli);
        command
            .args(&work.args)
            .current_dir(&work.dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
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
            _ = async { if !*cancel.borrow() { let _ = cancel.changed().await; } } => { let _ = child.kill().await; let _ = child.wait().await; None },
            result = child.wait() => Some(result),
        };
        let _ = out.await;
        let _ = err.await;
        if result.is_none() || *cancel.borrow() {
            self.finish(&work.id, "cancelled", None);
            let _ = std::fs::remove_dir_all(&work.dir);
            return;
        }
        match result.unwrap() {
            Ok(status) if status.success() => {
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
                Some(format!("sd-cli exited with {status}; see render log")),
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
        let config = self.root.join(id).join("pe-config.toml");
        std::fs::write(
            &config,
            "[server]\nn_ctx = 32768\nn_gpu_layers = 99\nuse_mmap = true\nuse_mlock = false\n",
        )
        .map_err(|e| e.to_string())?;
        let mut command = Command::new(&pe.cli);
        command.args([
            "--model",
            &pe.model,
            "--config",
            &config.to_string_lossy(),
            "--system-prompt",
            &system,
            "--prompt",
            &pe.prompt,
            "--chat",
            "--stream",
            "--max-tokens",
            "16256",
            "--temperature",
            "1.0",
            "--top-p",
            "0.95",
            "--top-k",
            "20",
        ]);
        if pe.think {
            command.arg("--think");
        }
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
            _ = async { if !*cancel.borrow() { let _ = cancel.changed().await; } } => { let _ = child.kill().await; let _ = child.wait().await; None },
            status = child.wait() => Some(status.map_err(|e| e.to_string())?),
        };
        let text = output.await.map_err(|e| e.to_string())?;
        let _ = logs.await;
        if status.is_none() || *cancel.borrow() {
            return Ok(None);
        }
        if !status.unwrap().success() {
            return Err("Prompt enhancer failed; see render log".into());
        }
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
            if j.stage != "enhance" && lower.contains("decoding") {
                j.stage = "decode".into();
            }
            if j.stage != "enhance" && lower.contains("save result") {
                j.stage = "save".into();
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
        if !r.paths.pe_model.to_ascii_lowercase().ends_with(".gguf") {
            return Err("Text enhancement requires GGUF weights, not an MLX model".into());
        }
        if !r.references.is_empty() {
            return Err("Prompt enhancement currently supports text-to-image only".into());
        }
        for (label, path) in [
            ("mlx-rs GGUF generate executable", &r.paths.pe_cli),
            ("PE-T2I weights", &r.paths.pe_model),
            ("PE-T2I system prompt", &r.paths.pe_system),
        ] {
            if !PathBuf::from(path).is_file() {
                return Err(format!("Select existing {label} in Paths"));
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
    if !matches!(s.device.as_str(), "auto" | "cpu" | "mps" | "cuda") {
        return Err("Unknown device".into());
    }
    if r.references.len() > 10 {
        return Err("At most 10 references are supported".into());
    }
    for (name, path) in [
        ("diffusion model", &r.paths.model),
        ("VAE", &r.paths.vae),
        ("text encoder", &r.paths.llm),
    ] {
        if !PathBuf::from(path).is_file() {
            return Err(format!("Select an existing {name} weight file in Paths"));
        }
    }
    if r.paths.pose_enabled && !r.references.is_empty() {
        let path = PathBuf::from(&r.paths.pose_lora);
        if !path.is_file() {
            return Err("Select an existing PoseStudio LoRA in Paths or disable it".into());
        }
        if !r.paths.pose_strength.is_finite() || !(0.0..=2.0).contains(&r.paths.pose_strength) {
            return Err("PoseStudio LoRA strength must be between 0 and 2".into());
        }
        if !path.file_stem().and_then(|s| s.to_str()).is_some_and(|s| {
            !s.is_empty()
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        }) {
            return Err(
                "PoseStudio LoRA filename must use letters, digits, dots, underscores or hyphens"
                    .into(),
            );
        }
    }
    if !r.references.is_empty() && !PathBuf::from(&r.paths.vision).is_file() {
        return Err("Editing needs a vision projection weight file in Paths".into());
    }
    Ok(())
}
fn arguments(r: &Request, refs: &[PathBuf], output: &std::path::Path) -> Vec<String> {
    let s = &r.settings;
    let mut prompt = if s.transparent {
        format!(
            "This is an RGBA image with transparency. {} The image has alpha channel and the background is transparent.",
            s.prompt
        )
    } else {
        s.prompt.clone()
    };
    if r.paths.pose_enabled && !refs.is_empty() {
        let path = PathBuf::from(&r.paths.pose_lora);
        let name = path.file_stem().unwrap().to_string_lossy();
        prompt.push_str(&format!(" <lora:{name}:{}>", r.paths.pose_strength));
    }
    let mut args = vec![
        "--diffusion-model".into(),
        r.paths.model.clone(),
        "--vae".into(),
        r.paths.vae.clone(),
        "--llm".into(),
        r.paths.llm.clone(),
        "-p".into(),
        prompt,
        "--width".into(),
        s.width.unwrap().to_string(),
        "--height".into(),
        s.height.unwrap().to_string(),
        "--steps".into(),
        s.steps.to_string(),
        "--seed".into(),
        s.seed.to_string(),
        "--cfg-scale".into(),
        if r.paths.turbo { "1.0" } else { "6.0" }.into(),
        "--sampling-method".into(),
        "euler".into(),
        "--rng".into(),
        "cpu".into(),
        "--params-backend".into(),
        "disk".into(),
        "-o".into(),
        output.to_string_lossy().into_owned(),
    ];
    if r.paths.pose_enabled && !refs.is_empty() {
        let path = PathBuf::from(&r.paths.pose_lora);
        args.extend([
            "--lora-model-dir".into(),
            path.parent().unwrap().to_string_lossy().into_owned(),
            "--lora-apply-mode".into(),
            "at_runtime".into(),
        ]);
    }
    if r.paths.turbo {
        args.extend(["--sigmas".into(), "qwen-image-2.1-turbo".into()]);
    }
    if s.device != "auto" {
        args.extend([
            "--backend".into(),
            match s.device.as_str() {
                "mps" => "MTL0",
                "cuda" => "CUDA0",
                _ => "CPU",
            }
            .into(),
        ]);
    }
    if !refs.is_empty() {
        args.extend(["--llm_vision".into(), r.paths.vision.clone()]);
        for path in refs {
            args.extend(["-r".into(), path.to_string_lossy().into_owned()]);
        }
    }
    args
}
fn progress(text: &str) -> Option<(u32, u32)> {
    if !text.contains('|') || !(text.contains("s/it") || text.contains("it/s")) {
        return None;
    };
    text.split_whitespace().find_map(|word| {
        let (a, b) = word.split_once('/')?;
        let a = a.parse().ok()?;
        let b = b.parse().ok()?;
        if a <= b && b > 0 { Some((a, b)) } else { None }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_only_denoising_progress() {
        assert_eq!(
            progress("  |====> | 2/40 - 0.75it/s\u{1b}[K"),
            Some((2, 40))
        );
        assert_eq!(progress("weights 2/40 - 3 MB/s"), None);
        assert_eq!(progress(" |===| 41/40 - 1.0s/it"), None);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn worker_runs_fifo_cancels_waiting_and_active_and_recovers_from_failure() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("theapp-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let weights = root.join("weights");
        std::fs::write(&weights, "fixture").unwrap();
        let source = root.join("source.png");
        image::RgbaImage::new(32, 32).save(&source).unwrap();
        let cli = root.join("fixture-cli");
        std::fs::write(&cli, format!("#!/bin/sh\nprompt=''\nwhile [ $# -gt 0 ]; do\n case \"$1\" in -p) prompt=\"$2\";; esac\n shift\ndone\ncase \"$prompt\" in noout) exit 0;; fail) echo 'fixture failure' >&2; exit 7;; slow) while true; do printf '\\r|=>| 1/2 - 0.50it/s'; /bin/sleep 0.05; done;; esac\nprintf '\\r|=>| 1/2 - 0.50it/s\\r|==| 2/2 - 0.50it/s\\n'\n/bin/cp '{}' output.png\n", source.display())).unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        let engine = Engine::new(root.join("renders"), &tokio::runtime::Handle::current());
        let request = |prompt: &str| Request {
            auto_ratio: false,
            session: "session-a".into(),
            settings: Settings {
                prompt: prompt.into(),
                width: Some(256),
                height: Some(256),
                steps: 2,
                seed: 42,
                enhance: false,
                think: false,
                transparent: false,
                device: "cpu".into(),
                ratio: None,
            },
            paths: Paths {
                pose_lora: String::new(),
                pose_enabled: false,
                pose_strength: 0.7,
                pe_cli: String::new(),
                pe_model: String::new(),
                pe_system: String::new(),
                turbo: false,
                cli: cli.to_string_lossy().into(),
                model: weights.to_string_lossy().into(),
                vae: weights.to_string_lossy().into(),
                llm: weights.to_string_lossy().into(),
                vision: weights.to_string_lossy().into(),
            },
            references: vec![],
        };
        let submit = |r| engine.submit(r).unwrap()["id"].as_str().unwrap().to_owned();
        let first = submit(request("slow"));
        wait_for(&engine, &first, "running").await;
        let queued = submit(request("queued-cancel"));
        let failed = submit(request("fail"));
        let mut edit = request("success");
        edit.references.push(Reference {
            png: STANDARD.encode(std::fs::read(&source).unwrap()),
        });
        let last = submit(edit);
        assert_eq!(engine.snapshot()["jobs"][3]["state"], "queued");
        engine.cancel(&queued).unwrap();
        engine.cancel(&first).unwrap();
        wait_for(&engine, &first, "cancelled").await;
        wait_for(&engine, &failed, "failed").await;
        wait_for(&engine, &last, "completed").await;
        let jobs = engine.snapshot();
        assert_eq!(jobs["jobs"][1]["state"], "cancelled");
        assert!(jobs["jobs"][2]["error"].as_str().unwrap().contains("7"));
        assert_eq!(jobs["jobs"][3]["step"], 2);
        assert_eq!(jobs["jobs"][3]["width"], 32);
        assert!(
            jobs["jobs"][3]["output"]
                .as_str()
                .unwrap()
                .starts_with("app://localhost/__stream__/")
        );
        let mut invalid = request("edit");
        invalid.references.push(Reference {
            png: "not base64".into(),
        });
        let invalid_id = submit(invalid);
        wait_for(&engine, &invalid_id, "failed").await;
        let missing = submit(request("noout"));
        wait_for(&engine, &missing, "failed").await;
        assert!(
            engine.snapshot()["jobs"]
                .as_array()
                .unwrap()
                .iter()
                .find(|j| j["id"] == missing)
                .unwrap()["error"]
                .as_str()
                .unwrap()
                .contains("No valid output")
        );
        let mut invalid = request("dimensions");
        invalid.settings.width = Some(257);
        assert!(validate(&invalid).is_err());
        let r = request("quote ' $(touch injected) <image1>");
        let args = arguments(
            &r,
            &[root.join("ref 1.png"), root.join("ref 2.png")],
            &root.join("output.png"),
        );
        assert_eq!(
            args[args.iter().position(|v| v == "-p").unwrap() + 1],
            r.settings.prompt
        );
        assert_eq!(args.iter().filter(|v| *v == "-r").count(), 2);
        assert_eq!(
            args[args.iter().position(|v| v == "--params-backend").unwrap() + 1],
            "disk"
        );
        assert!(
            !args
                .iter()
                .any(|v| v == "--offload-to-cpu" || v == "--eager-load")
        );
        assert_eq!(
            args[args.iter().position(|v| v == "--llm_vision").unwrap() + 1],
            r.paths.vision
        );
        let references: Vec<_> = args
            .windows(2)
            .filter(|pair| pair[0] == "-r")
            .map(|pair| pair[1].clone())
            .collect();
        assert_eq!(
            references,
            vec![
                root.join("ref 1.png").to_string_lossy(),
                root.join("ref 2.png").to_string_lossy()
            ]
        );

        let mut pose = request("pose test");
        pose.references.push(Reference { png: String::new() });
        pose.paths.pose_enabled = true;
        pose.paths.pose_lora = root.join("pose.safetensors").to_string_lossy().into_owned();
        assert!(validate(&pose).is_err());
        std::fs::write(&pose.paths.pose_lora, "fixture").unwrap();
        assert!(validate(&pose).is_ok());
        let pose_args = arguments(&pose, &[root.join("ref.png")], &root.join("pose.png"));
        assert!(pose_args.contains(&"at_runtime".into()));
        assert_eq!(
            pose_args[pose_args.iter().position(|v| v == "-p").unwrap() + 1],
            "pose test <lora:pose:0.7>"
        );
        assert_eq!(
            pose_args[pose_args
                .iter()
                .position(|v| v == "--lora-model-dir")
                .unwrap()
                + 1],
            root.to_string_lossy()
        );
        pose.paths.pose_strength = f32::NAN;
        assert!(validate(&pose).is_err());
        pose.paths.pose_strength = 0.7;
        pose.paths.pose_enabled = false;
        assert!(
            !arguments(&pose, &[root.join("ref.png")], &root.join("pose.png"))
                .contains(&"--lora-model-dir".into())
        );
        pose.paths.pose_enabled = true;
        pose.references.clear();
        assert!(
            !arguments(&pose, &[], &root.join("pose.png")).contains(&"--lora-model-dir".into())
        );

        let mut turbo = request("turbo");
        turbo.paths.turbo = true;
        assert!(validate(&turbo).is_err());
        turbo.settings.steps = 8;
        assert!(validate(&turbo).is_ok());
        let args = arguments(&turbo, &[], &root.join("turbo.png"));
        assert_eq!(
            args[args.iter().position(|v| v == "--params-backend").unwrap() + 1],
            "disk"
        );
        assert!(
            !args
                .iter()
                .any(|v| v == "--llm_vision" || v == "--offload-to-cpu" || v == "--eager-load")
        );

        assert_eq!(
            args[args.iter().position(|v| v == "--sigmas").unwrap() + 1],
            "qwen-image-2.1-turbo"
        );
        assert_eq!(
            args[args.iter().position(|v| v == "--cfg-scale").unwrap() + 1],
            "1.0"
        );

        let pe = root.join("fixture-generate");
        std::fs::write(&pe, "#!/bin/sh\nprompt=''\nwhile [ $# -gt 0 ]; do case \"$1\" in --prompt) prompt=\"$2\";; esac; shift; done\ncase \"$prompt\" in slow-pe) while true; do /bin/sleep 0.05; done;; bad-pe) echo malformed; exit 0;; esac\necho '{\"rewritten_prompt\":\"Enhanced mug photograph\",\"wh_ratio\":\"1:1\"}'\n").unwrap();
        std::fs::set_permissions(&pe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let pe_model = root.join("pe.gguf");
        std::fs::write(&pe_model, "fixture").unwrap();
        let enhanced = |prompt: &str| {
            let mut r = request(prompt);
            r.settings.enhance = true;
            r.paths.pe_cli = pe.to_string_lossy().into_owned();
            r.paths.pe_model = pe_model.to_string_lossy().into_owned();
            r.paths.pe_system = weights.to_string_lossy().into_owned();
            r
        };
        let enhanced_id = submit(enhanced("enhance"));
        wait_for(&engine, &enhanced_id, "completed").await;
        assert_eq!(
            engine.snapshot()["jobs"]
                .as_array()
                .unwrap()
                .iter()
                .find(|j| j["id"] == enhanced_id)
                .unwrap()["enhanced_prompt"],
            "Enhanced mug photograph"
        );
        let malformed = submit(enhanced("bad-pe"));
        wait_for(&engine, &malformed, "failed").await;
        assert!(
            !root
                .join("renders")
                .join(&malformed)
                .join("output.png")
                .exists()
        );
        let slow = submit(enhanced("slow-pe"));
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if engine.snapshot()["jobs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|j| j["id"] == slow && j["stage"] == "enhance")
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        engine.cancel(&slow).unwrap();
        wait_for(&engine, &slow, "cancelled").await;
        let recovery = submit(request("success"));
        wait_for(&engine, &recovery, "completed").await;
        engine.shutdown();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn parses_enhancer_json_after_thinking_and_keeps_braces_in_strings() {
        assert_eq!(parse_enhancement("<think>example {\"rewritten_prompt\":\"wrong\"}</think>\n```json\n{\"rewritten_prompt\":\"A sign reading {HELLO}\",\"wh_ratio\":\"16:9\"}\n```\n[done]").unwrap(), ("A sign reading {HELLO}".into(), "16:9".into()));
        assert!(parse_enhancement("thinking only").is_err());
        assert_eq!(ratio_size("16:9"), Some((2752, 1536)));
        assert_eq!(ratio_size("1:0"), None);
    }
    #[test]
    fn finds_vision_in_cache_without_loading_weights() {
        let hub = std::env::temp_dir().join(format!("theapp-cache-test-{}", Uuid::new_v4()));
        let snapshot = hub.join("models--unsloth--Qwen3-VL-8B-Instruct-GGUF/snapshots/test");
        std::fs::create_dir_all(&snapshot).unwrap();
        let vision = snapshot.join("mmproj-F16.gguf");
        std::fs::write(&vision, "fixture").unwrap();
        assert_eq!(
            cached_paths_in(&hub, "sd-cli".into()).vision,
            vision.to_string_lossy()
        );
        std::fs::remove_dir_all(hub).unwrap();
    }
    async fn wait_for(engine: &Engine, id: &str, state: &str) {
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
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("Job did not reach {state}: {}", engine.snapshot()));
    }
}

pub fn cached_paths(cli: String) -> Paths {
    let hub = std::env::var_os("HF_HUB_CACHE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HF_HOME").map(|p| PathBuf::from(p).join("hub")))
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_default()
                .join(".cache/huggingface/hub")
        });
    cached_paths_in(&hub, cli)
}

fn cached_paths_in(hub: &std::path::Path, cli: String) -> Paths {
    let find = |repo: &str, suffix: &str| -> String {
        fn visit(dir: &std::path::Path, suffix: &str, depth: u32) -> Option<PathBuf> {
            if depth == 0 {
                return None;
            }
            let mut entries: Vec<_> = std::fs::read_dir(dir)
                .ok()?
                .filter_map(Result::ok)
                .map(|e| e.path())
                .collect();
            entries.sort();
            for path in entries {
                if path.is_file() && path.file_name()?.to_string_lossy().ends_with(suffix) {
                    return Some(path);
                }
                if path.is_dir() {
                    if let Some(found) = visit(&path, suffix, depth - 1) {
                        return Some(found);
                    }
                }
            }
            None
        }
        visit(&hub.join(repo).join("snapshots"), suffix, 4)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let model = find(
        "models--unsloth--Qwen-Image-2.1-Turbo-GGUF",
        "qwen-image-2.1-turbo-Q8_0.gguf",
    );
    let pose_lora = find(
        "models--MIUProject--VNCCS_PoseStudio_QI2.1",
        "VNCCS_QI2_PoseStudioV1.1.safetensors",
    );
    Paths {
        pose_enabled: !pose_lora.is_empty(),
        pose_lora,
        pose_strength: 0.7,
        pe_cli: concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../mlx-rs/target/release/generate"
        )
        .into(),
        pe_model: find(
            "models--mozophe--Qwen-Image-2.1-PE-MTP-GGUF",
            "qwen3.5_9b_qwen_image_2.1_pe_t2i.mtp.Q4_K_M.gguf",
        ),
        pe_system: find("models--Qwen--Qwen-Image-2.1-PE-T2I", "system_prompt.txt"),
        cli,
        turbo: !model.is_empty(),
        model,
        vae: find(
            "models--Comfy-Org--Qwen-Image-2.1",
            "qwen_image_2.1_vae_bf16.safetensors",
        ),
        llm: find(
            "models--unsloth--Qwen3-VL-8B-Instruct-GGUF",
            "Qwen3-VL-8B-Instruct-Q4_K_M.gguf",
        ),
        vision: find(
            "models--unsloth--Qwen3-VL-8B-Instruct-GGUF",
            "mmproj-F16.gguf",
        ),
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
