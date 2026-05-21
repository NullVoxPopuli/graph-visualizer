//! Validate + time the Rust data pipeline (parse + Louvain + radii)
//! against the JS numbers. Run on a real example file:
//!   cargo run --release --bin pipebench -- ../../public/examples/large.json
//!
//! JS baseline measured earlier on large.json: parse ~122 ms,
//! Louvain ~219 ms.

use std::time::Instant;

use layout_wasm::{graph, GraphSession};

/// Same cluster-separation quality proxy as the JS bench.
fn cluster_sep(pos: &[f32], comm: &[i32]) -> f64 {
    use std::collections::HashMap;
    let mut order: HashMap<i32, usize> = HashMap::new();
    for &c in comm {
        let next = order.len();
        order.entry(c).or_insert(next);
    }
    let k = order.len();
    if k < 2 {
        return f64::INFINITY;
    }
    let (mut sx, mut sy, mut cnt) = (vec![0f64; k], vec![0f64; k], vec![0f64; k]);
    for (i, &c) in comm.iter().enumerate() {
        let ci = order[&c];
        sx[ci] += pos[2 * i] as f64;
        sy[ci] += pos[2 * i + 1] as f64;
        cnt[ci] += 1.0;
    }
    for c in 0..k {
        sx[c] /= cnt[c].max(1.0);
        sy[c] /= cnt[c].max(1.0);
    }
    let mut spread = vec![0f64; k];
    for (i, &c) in comm.iter().enumerate() {
        let ci = order[&c];
        let dx = pos[2 * i] as f64 - sx[ci];
        let dy = pos[2 * i + 1] as f64 - sy[ci];
        spread[ci] += (dx * dx + dy * dy).sqrt();
    }
    for c in 0..k {
        spread[c] /= cnt[c].max(1.0);
    }
    let mut sum = 0.0;
    for a in 0..k {
        let mut nearest = f64::INFINITY;
        for b in 0..k {
            if a == b {
                continue;
            }
            let dx = sx[a] - sx[b];
            let dy = sy[a] - sy[b];
            nearest = nearest.min((dx * dx + dy * dy).sqrt());
        }
        sum += nearest / spread[a].max(1.0);
    }
    sum / k as f64
}

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

    let t = Instant::now();
    let cyc = graph::has_any_cycle(n, &g.edges_flat, &g.edge_type_ids, None);
    let cyc_ms = t.elapsed().as_secs_f64() * 1000.0;

    let t = Instant::now();
    let orphans = graph::find_orphans(
        n,
        &g.edges_flat,
        &g.edge_type_ids,
        &g.in_degree,
        None,
        None,
    );
    let orph_ms = t.elapsed().as_secs_f64() * 1000.0;
    let any_orphan = graph::has_any_orphan(n, &g.edges_flat, &g.edge_type_ids, &g.in_degree, None);

    println!("  hasAnyCycle  {cyc_ms:8.3} ms   -> {cyc}");
    println!(
        "  findOrphans  {orph_ms:8.3} ms   -> {} orphans (hasAnyOrphan={any_orphan})",
        orphans.len()
    );

    let t = Instant::now();
    let bundled =
        graph::find_bundled_cycles_via_raw(n, &g.edges_flat, &g.edge_type_ids, None, None);
    let bnd_ms = t.elapsed().as_secs_f64() * 1000.0;
    let mut lens: Vec<usize> = bundled.iter().map(|c| c.len()).collect();
    lens.sort_unstable();
    let lmin = lens.first().copied().unwrap_or(0);
    let lmax = lens.last().copied().unwrap_or(0);
    println!(
        "  bundledCycles{bnd_ms:8.3} ms   -> {} (len {}..{})",
        bundled.len(),
        lmin,
        lmax
    );

    println!("--- resident GraphSession ---");
    let t = Instant::now();
    let mut s = GraphSession::load(&json).expect("session load");
    let load_ms = t.elapsed().as_secs_f64() * 1000.0;

    let t = Instant::now();
    let pos = s.layout(1.0, 6.0, 18.0, 180.0, 0.12, false, None);
    let lay_ms = t.elapsed().as_secs_f64() * 1000.0;
    let sep = cluster_sep(&pos, &s.communities());

    // Slider tweak: re-cluster + warm relayout from the current positions.
    let t = Instant::now();
    s.set_resolution(1.4);
    let recluster_ms = t.elapsed().as_secs_f64() * 1000.0;
    let t = Instant::now();
    let pos2 = s.layout(1.0, 9.0, 18.0, 180.0, 0.12, true, None);
    let warm_ms = t.elapsed().as_secs_f64() * 1000.0;
    let sep2 = cluster_sep(&pos2, &s.communities());

    println!("  load (parse+radii+louvain) {load_ms:8.1} ms");
    println!("  layout (cold)              {lay_ms:8.1} ms   cluster-sep {sep:.2}");
    println!("  set_resolution(1.4)        {recluster_ms:8.1} ms");
    println!("  layout (warm, new params)  {warm_ms:8.1} ms   cluster-sep {sep2:.2}");
}
