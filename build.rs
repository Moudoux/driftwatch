// Ensures `web/dist` exists so `rust-embed` compiles even before the UI is built.
fn main() {
    let dist = std::path::Path::new("web/dist");
    if !dist.join("index.html").exists() {
        std::fs::create_dir_all(dist).expect("create web/dist");
        std::fs::write(
            dist.join("index.html"),
            "<!doctype html><title>Driftwatch</title><p>The web UI was not built. Run <code>pnpm build</code> in <code>web/</code>.</p>",
        )
        .expect("write placeholder index.html");
    }
    println!("cargo:rerun-if-changed=web/dist");
}
