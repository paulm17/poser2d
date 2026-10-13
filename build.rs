use std::{env, path::PathBuf, process::Command};

fn main() {
    let frontend = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("frontend");
    for path in [
        "src",
        "scene-builder",
        "package.json",
        "package-lock.json",
        "vite.config.ts",
        "tsconfig.json",
        "index.html",
    ] {
        println!("cargo:rerun-if-changed=frontend/{path}");
    }
    if !frontend.join("node_modules").is_dir()
        || !frontend.join("node_modules/.package-lock.json").is_file()
        || std::fs::read(frontend.join("package-lock.json")).ok()
            != std::fs::read(frontend.join(".installed-package-lock.json")).ok()
    {
        run(&frontend, &["ci"]);
        std::fs::copy(
            frontend.join("package-lock.json"),
            frontend.join(".installed-package-lock.json"),
        )
        .expect("record installed frontend dependencies");
    }
    run(&frontend, &["run", "build"]);
}

fn run(dir: &std::path::Path, args: &[&str]) {
    let status = Command::new("npm")
        .args(args)
        .current_dir(dir)
        .status()
        .expect("frontend build requires npm in PATH");
    assert!(status.success(), "npm {} failed", args.join(" "));
}
