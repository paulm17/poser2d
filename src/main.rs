mod engine;
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "frontend/dist/"]
struct Assets;

fn main() {
    let runtime = tokio::runtime::Runtime::new().expect("start engine runtime");
    let root = dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("qwen-image-studio/renders");
    let engine = engine::Engine::new(root, runtime.handle());
    let submit = engine.clone();
    let cancel = engine.clone();
    let snapshot = engine.clone();
    let ready = engine.clone();
    let shutdown = engine.clone();
    if let Err(error) = rust_cef::App::new()
        .title("Qwen Image Studio")
        .assets(|path| Assets::get(path))
        .register_ipc("submit_generation", move |args| {
            submit.submit(serde_json::from_value(args.clone()).map_err(|e| e.to_string())?)
        })
        .register_ipc("cancel_generation", move |args| {
            cancel.cancel(args["id"].as_str().ok_or("Missing job ID")?)
        })
        // app:// loads do not currently signal ContentLoaded in rust-cef.
        // The frontend sends this after installing its event subscription.
        .register_ipc("engine_subscribed", |_| {
            rust_cef::EVENT_LOOP_PROXY
                .get()
                .ok_or("Event loop is not ready")?
                .lock()
                .map_err(|e| e.to_string())?
                .send_event(rust_cef::AppEvent::ContentLoaded)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!(null))
        })
        .register_ipc("get_jobs", move |_| Ok(snapshot.snapshot()))
        .register_ipc("engine_defaults", move |_| {
            let bundled = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.join("sd-cli")));
            let cli = bundled.filter(|p| p.is_file()).unwrap_or_else(|| {
                std::path::PathBuf::from(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/stable-diffusion.cpp/build/bin/sd-cli"
                ))
            });
            Ok(serde_json::json!(engine::cached_paths(
                cli.to_string_lossy().into_owned()
            )))
        })
        .on_ready(move |handle| ready.set_sender(handle.event_sender()))
        .on_exit(move || shutdown.shutdown())
        .run()
    {
        eprintln!("Failed to start Qwen Image Studio: {error}");
        std::process::exit(1);
    }
}
