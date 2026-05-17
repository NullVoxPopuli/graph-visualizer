//! Validate + time the Rust data pipeline (parse + Louvain + radii)
//! against the JS numbers. Run on a real example file:
//!   cargo run --release --bin pipebench -- ../../public/examples/large.json
//!
//! JS baseline measured earlier on large.json: parse ~122 ms,
//! Louvain ~219 ms.

use std::time::Instant;

use layout_wasm::graph;

fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "../../public/examples/large.json".to_string());
    let json = std::fs::read_to_string(&path).expect("read json");

    let t = Instant::now();
    let g = graph::parse(&json).expect("parse");
    let parse_ms = t.elapsed().as_secs_f64() * 1000.0;
    let n = g.ids.len();
    let edges = g.edges_flat.len() / 2;

    let t = Instant::now();
    let comms = graph::louvain(n, &g.edges_flat, 1.0);
    let louv_ms = t.elapsed().as_secs_f64() * 1000.0;

    let t = Instant::now();
    let radii = graph::compute_radii(&g.in_degree, &g.out_degree);
    let rad_ms = t.elapsed().as_secs_f64() * 1000.0;

    let distinct: std::collections::HashSet<i32> = comms.iter().copied().collect();
    let rmin = radii.iter().cloned().fold(f32::INFINITY, f32::min);
    let rmax = radii.iter().cloned().fold(f32::NEG_INFINITY, f32::max);

    println!("{path}");
    println!("  nodes {n}  edges {edges}  communities {}", distinct.len());
    println!("  parse        {parse_ms:8.1} ms   (JS ~122)");
    println!("  louvain      {louv_ms:8.1} ms   (JS ~219)");
    println!("  computeRadii {rad_ms:8.3} ms");
    println!("  radii range  [{rmin:.2}, {rmax:.2}]");
}
