//! Run the six real validation jobs through the desktop app's backend.
#[allow(dead_code)]
#[path = "../engine.rs"]
mod engine;
use base64::Engine as _;
use engine::{Engine, Reference, Request, Settings};
use serde_json::json;
use std::path::PathBuf;
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let artifacts = root.join("artifacts/vpipe-validation");
    std::fs::create_dir_all(&artifacts)?;
    let engine = Engine::new(artifacts.clone(), &tokio::runtime::Handle::current());
    let cli = root.join("vpipe/build/apps/vpipe/vpipe");
    let paths = engine::cached_paths(cli.to_string_lossy().into_owned());
    let reference = std::env::args().nth(1).unwrap_or_else(|| "/Volumes/Data/Users/paul/scratch/awakenJesus/books/manga/source images/thekenoma/yahweh/christian_yahweh_halo_no_bg.png".into());
    let png = base64::engine::general_purpose::STANDARD.encode(std::fs::read(&reference)?);
    let second_png = match std::env::args().nth(2) {
        Some(path) => base64::engine::general_purpose::STANDARD.encode(std::fs::read(path)?),
        None => png.clone(),
    };
    let mut results: Vec<serde_json::Value> = std::fs::read(artifacts.join("results.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let mut failed = false;
    let size: u32 = std::env::var("VPIPE_VALIDATION_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(512);
    for model in ["turbo-4", "turbo-8", "base-8", "base-4"] {
        let bits = if model.ends_with("8") { 8 } else { 4 };
        for mode in [
            "t2i",
            "i2i",
            "pose",
            "enhanced",
            "enhanced-i2i",
            "enhanced-multi",
        ] {
            let name = format!("{model}-{mode}");
            if let Ok(filter) = std::env::var("VPIPE_VALIDATION_FILTER") {
                if !filter.split(',').any(|f| f == name) {
                    continue;
                }
            }
            let mut paths = paths.clone();
            paths.quant_bits = bits;
            paths.lightning_enabled = model.starts_with("base");
            paths.pose_enabled = mode == "pose";
            let req = Request {
                loras:None,model_id:Some(model.into()),auto_ratio:false,session:name.clone(),paths,
                references:if mode == "enhanced-multi" { vec![Reference{png:png.clone()}, Reference{png:second_png.clone()}] } else if mode!="t2i" && mode!="enhanced" { vec![Reference{png:png.clone()}] } else {vec![]},
                settings:Settings { prompt:if mode == "enhanced-multi" {"Use <image1> as the subject and <image2> as the style reference. Place the subject on a beach at sunset."} else if mode!="t2i" && mode!="enhanced" {"Place this character on a quiet beach at sunset, preserving her face, pointed ears, white dress, and full-body standing pose."} else {"A blue ceramic mug on a wooden table beside a window, soft morning light"}.into(),width:Some(size),height:Some(size),steps:8,cfg:1.0,seed:42,enhance:mode.starts_with("enhanced"),think:false,transparent:false,device:"mps".into(),ratio:Some("1:1".into()) }
            };
            let identity = serde_json::to_value(&req.paths)?;
            let id = engine.submit(req).map_err(std::io::Error::other)?["id"]
                .as_str()
                .unwrap()
                .to_string();
            eprintln!("Running {name}: {id}");
            let started = std::time::Instant::now();
            let mut next_report = 60;
            let job = loop {
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
                if started.elapsed().as_secs() >= next_report {
                    eprintln!(
                        "{name}: {} {}/{} ({}s)",
                        job["stage"],
                        job["step"],
                        job["total"],
                        started.elapsed().as_secs()
                    );
                    next_report += 60;
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            };
            let log =
                std::fs::read_to_string(artifacts.join(&id).join("render.log")).unwrap_or_default();
            let rss: Vec<u64> = log
                .lines()
                .filter(|l| l.contains("maximum resident set size"))
                .filter_map(|l| l.split_whitespace().next()?.parse().ok())
                .collect();
            let footprint: Vec<u64> = log
                .lines()
                .filter(|l| l.contains("peak memory footprint"))
                .filter_map(|l| l.split_whitespace().next()?.parse().ok())
                .collect();
            let result = json!({"name":name,"id":id,"paths":identity,"elapsed_seconds":started.elapsed().as_secs_f64(),"peak_rss_bytes":rss.iter().max(),"phase_peak_rss_bytes":rss,"peak_footprint_bytes":footprint.iter().max(),"job":job});
            std::fs::write(
                artifacts.join(&id).join("result.json"),
                serde_json::to_vec_pretty(&result)?,
            )?;
            if result["job"]["state"] == "completed" {
                let dims = image::image_dimensions(artifacts.join(&id).join("output.png"))?;
                if dims != (size, size) {
                    return Err(format!("{name}: wrong dimensions {dims:?}").into());
                }
            }
            eprintln!(
                "{name}: {} {}",
                result["job"]["state"], result["job"]["error"]
            );
            failed |= result["job"]["state"] != "completed";
            results.retain(|r| r["name"] != name);
            results.push(result);
            std::fs::write(
                artifacts.join("results.json"),
                serde_json::to_vec_pretty(&results)?,
            )?;
        }
    }
    if failed {
        return Err(
            "One or more validation jobs failed; see artifacts/vpipe-validation/results.json"
                .into(),
        );
    }
    Ok(())
}
