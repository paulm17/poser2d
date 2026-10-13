use rust_cef_packager::{MacOsBundleConfig, bundle_dev_app};
use std::{error::Error, path::PathBuf, process::Command};

fn main() -> Result<(), Box<dyn Error>> {
    if !cfg!(target_os = "macos") {
        return Err("This development bundle command requires macOS".into());
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    for (program, args, dir) in [
        ("npm", vec!["run", "build"], root.join("frontend")),
        ("cargo", vec!["build", "-p", "theapp"], root.clone()),
    ] {
        if !Command::new(program)
            .args(args)
            .current_dir(dir)
            .status()?
            .success()
        {
            return Err(format!("{program} build failed").into());
        }
    }
    let bundle = bundle_dev_app(&MacOsBundleConfig {
        workspace_dir: root.clone(),
        target_dir: root.join("target/debug"),
        app_name: "Qwen Image Studio".into(),
        main_exe_name: "theapp".into(),
        bundle_identifier: "com.qwenimagestudio.app".into(),
        url_name: "com.qwenimagestudio.app.deeplink".into(),
        url_schemes: vec![],
        document_type_name: "Qwen Image Studio Document".into(),
        document_type_identifier: "com.qwenimagestudio.document".into(),
        document_extension: "qwenstudio".into(),
        helper_bundle_id_base: "com.qwenimagestudio.helper".into(),
        framework_name: "Chromium Embedded Framework.framework".into(),
    })?;
    let cli = root.join("stable-diffusion.cpp/build/bin/sd-cli");
    if !cli.is_file() {
        return Err("Build stable-diffusion.cpp/build/bin/sd-cli before bundling".into());
    }
    std::fs::copy(cli, bundle.join("Contents/MacOS/sd-cli"))?;
    // rust-cef currently looks for this fixed helper name inside macOS bundles.
    let framework = bundle.join("Contents/Frameworks/Chromium Embedded Framework.framework");
    let macos = bundle.join("Contents/MacOS");
    for source in [framework.join("Resources"), framework.join("Libraries")] {
        if source.exists()
            && !Command::new("cp")
                .arg("-R")
                .arg(source.join("."))
                .arg(&macos)
                .status()?
                .success()
        {
            return Err("Failed to copy CEF runtime resources".into());
        }
    }
    for suffix in ["", " (Renderer)", " (GPU)", " (Plugin)"] {
        let name = format!("Rust CEF Helper{suffix}");
        let contents = bundle
            .join("Contents/Frameworks")
            .join(format!("{name}.app/Contents"));
        std::fs::create_dir_all(contents.join("MacOS"))?;
        std::fs::copy(macos.join("theapp"), contents.join("MacOS").join(&name))?;
        let id_suffix = suffix.replace([' ', '(', ')'], "").to_lowercase();
        std::fs::write(
            contents.join("Info.plist"),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>{name}</string>
<key>CFBundleIdentifier</key><string>com.qwenimagestudio.helper.{id_suffix}</string>
<key>CFBundleName</key><string>{name}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>"#
            ),
        )?;
    }
    println!("Built {}", bundle.display());
    Ok(())
}
