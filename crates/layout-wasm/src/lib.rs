//! Faithful Rust/WASM port of the d3-force pipeline in `app/lib/layout-core.ts`.
//!
//! This is a *behavioral* port, not a numeric clone: it reimplements the
//! exact forces, constants, force-application order, integrator, seeding,
//! and the shared LCG (so jiggle on coincident points behaves the same),
//! against the d3-force v3 source. Tiny floating-point drift vs the JS run
//! is expected (operation ordering, the data-range vs power-of-two quadtree
//! root); the resulting layout is equivalent, which is what matters for a
//! perf comparison and a drop-in worker.
//!
//! Mirrors of the JS:
//!   - simulation.js : alpha/alphaDecay/alphaTarget, velocityDecay (`1 - _`),
//!                     integrate `x += vx *= velocityDecay`
//!   - manyBody.js   : Barnes-Hut quadtree, `theta`, distanceMin2 = 1
//!   - link.js       : per-list `count`/`bias`, constant strength + distance
//!   - collide.js    : quadtree, `iterations`, strength, index-ordered pairs
//!   - center.js     : positional re-centering
//!   - the custom `communityCohesionForce` / `seedByCommunity` /
//!     `applyClusterSpread` from layout-core.ts

use wasm_bindgen::prelude::*;

pub mod graph;

const GOLDEN_ANGLE: f64 = 137.508 * (std::f64::consts::PI / 180.0);
const MAX_INDEXED_COMM: usize = 200_000;
const MAX_TICKS: usize = 500;
const BATCH: usize = 8;
const ALPHA_MIN: f64 = 0.001;
const ALPHA_TARGET: f64 = 0.0;
// d3's `velocityDecay(_)` setter stores `1 - _`; layout-core calls
// `.velocityDecay(0.35)`, so the value used in the integrator is 0.65.
const VELOCITY_DECAY: f64 = 1.0 - 0.35;
const THETA2: f64 = 0.9 * 0.9;
const DISTANCE_MIN2: f64 = 1.0;
const CENTER_STRENGTH: f64 = 0.005;
const INTRA_STRENGTH: f64 = 0.5;
const INTER_STRENGTH: f64 = 0.12;
const COLLIDE_STRENGTH: f64 = 0.85;
// Single fast schedule (no faithful/config option by design): a steep
// alpha decay reaches alphaMin in ~150 ticks and collide runs one
// iteration. Combined with the quiescence early-exit below, the layout
// settles in a fraction of d3's ~342-tick schedule. We optimize for
// "communities + layout look good, fast" — not for matching d3.
const ALPHA_DECAY: f64 = 0.045;
const COLLIDE_ITERATIONS: usize = 1;
// Quiescence: stop once the furthest a node moves across a whole batch
// drops below QUIET_REL × (RMS layout radius) for QUIET_WINDOWS batches
// in a row ("2 iterations of nodes barely moving"). Net per-batch
// movement (not per-tick) so a slow global crawl still counts as motion.
const QUIET_REL: f64 = 1.0e-3;
const QUIET_WINDOWS: usize = 2;

/// d3-force's `lcg.js`, shared across forces for the whole run (the
/// simulation creates one `random` and hands the same instance to every
/// force). Only consumed by `jiggle` on exactly-coincident points.
struct Lcg {
    s: u64,
}

impl Lcg {
    fn new() -> Self {
        Lcg { s: 1 }
    }

    fn next(&mut self) -> f64 {
        // s = (1664525 * s + 1013904223) % 2^32
        self.s = (1664525u64.wrapping_mul(self.s).wrapping_add(1013904223)) % 4294967296;
        self.s as f64 / 4294967296.0
    }

    fn jiggle(&mut self) -> f64 {
        (self.next() - 0.5) * 1e-6
    }
}

/// Node state, struct-of-arrays for cache-friendly tight loops.
struct Nodes {
    x: Vec<f64>,
    y: Vec<f64>,
    vx: Vec<f64>,
    vy: Vec<f64>,
}

// --------------------------------------------------------------------------
// Quadtree
//
// A d3-quadtree-equivalent: square cells, half-split, child index
// `(y >= ym) << 1 | (x >= xm)`, exactly-coincident points chained in a
// leaf. Built fresh each force application, exactly like d3.
// --------------------------------------------------------------------------

const NONE: u32 = u32::MAX;
const MAX_DEPTH: u32 = 52;

// --------------------------------------------------------------------------
// The simulation
// --------------------------------------------------------------------------

struct Sim {
    n: usize,
    nodes: Nodes,
    communities: Vec<i32>,
    // forceManyBody strengths (per node, by index).
    charge: Vec<f64>,
    // forceCollide radii (per node, by index).
    coll_r: Vec<f64>,
    // Links, split intra/inter, with per-list bias.
    intra: Links,
    inter: Links,
    cohesion: f64,
    spread_factor: f64,
    rng: Lcg,
}

struct Links {
    src: Vec<usize>,
    tgt: Vec<usize>,
    bias: Vec<f64>,
    distance: f64,
    strength: f64,
}

impl Links {
    fn build(pairs: &[(usize, usize)], n: usize, distance: f64, strength: f64) -> Self {
        let m = pairs.len();
        let mut count = vec![0i32; n];
        for &(s, t) in pairs {
            count[s] += 1;
            count[t] += 1;
        }
        let mut src = Vec::with_capacity(m);
        let mut tgt = Vec::with_capacity(m);
        let mut bias = Vec::with_capacity(m);
        for &(s, t) in pairs {
            // d3 link.js: bias = count[source] / (count[source] + count[target])
            bias.push(count[s] as f64 / (count[s] + count[t]) as f64);
            src.push(s);
            tgt.push(t);
        }
        Links {
            src,
            tgt,
            bias,
            distance,
            strength,
        }
    }
}

/// Run the layout. Single fast schedule + quiescence early-exit (stops
/// once nodes are barely moving for two batches running) — no faithful
/// mode by design; we optimize for a good-looking layout, fast.
///
/// `progress`, when provided, is called once per batch with
/// `(permille, 1000)` (same 0..1000 convention as the JS worker) so a
/// long run can drive a progress bar — the WASM run is otherwise a
/// single synchronous call.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn run_layout(
    node_count: usize,
    edges: &[i32],
    communities: &[i32],
    radii: &[f32],
    spread_factor: f64,
    repulsion: f64,
    node_distance: f64,
    cluster_distance: f64,
    cohesion: f64,
    progress: Option<js_sys::Function>,
) -> Vec<f32> {
    let radii_f64: Vec<f64> = radii.iter().map(|&v| v as f64).collect();
    simulate(
        node_count,
        edges,
        communities,
        &radii_f64,
        spread_factor,
        repulsion,
        node_distance,
        cluster_distance,
        cohesion,
        None,
        progress.as_ref(),
    )
}

/// Shared simulation core. `warm` (flat `[x,y,…]` of length `n*2`), when
/// given, seeds from those positions instead of the community sunflower
/// — a warm start so a slider tweak re-relaxes from the current layout
/// instead of reseeding. Used by both the legacy `run_layout` free
/// function and the resident `GraphSession`.
#[allow(clippy::too_many_arguments)]
fn simulate(
    node_count: usize,
    edges: &[i32],
    communities_in: &[i32],
    radii_in: &[f64],
    spread_factor: f64,
    repulsion: f64,
    node_distance: f64,
    cluster_distance: f64,
    cohesion: f64,
    warm: Option<&[f32]>,
    progress: Option<&js_sys::Function>,
) -> Vec<f32> {
    let n = node_count;
    let radii: Vec<f64> = radii_in.to_vec();
    let communities: Vec<i32> = communities_in.to_vec();

    // Mirror layout-core: inter-cluster spring distance scales with sqrt(n).
    let inter_distance_scale = (1.0f64).max((n as f64 / 200.0).sqrt());
    let effective_cluster_distance = cluster_distance * inter_distance_scale;

    // Partition edges into intra/inter community link lists (skip self).
    let mut intra_pairs: Vec<(usize, usize)> = Vec::new();
    let mut inter_pairs: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i + 1 < edges.len() {
        let a = edges[i] as usize;
        let b = edges[i + 1] as usize;
        i += 2;
        if a == b {
            continue;
        }
        if communities[a] == communities[b] {
            intra_pairs.push((a, b));
        } else {
            inter_pairs.push((a, b));
        }
    }

    let mut nodes = Nodes {
        x: vec![0.0; n],
        y: vec![0.0; n],
        vx: vec![0.0; n],
        vy: vec![0.0; n],
    };
    match warm {
        Some(prev) if prev.len() == n * 2 => {
            for i in 0..n {
                nodes.x[i] = prev[2 * i] as f64;
                nodes.y[i] = prev[2 * i + 1] as f64;
            }
        }
        _ => seed_by_community(&mut nodes, &communities, &radii),
    }

    // Per-node force parameters (forceManyBody / forceCollide initialize()).
    let mut charge = vec![0.0; n];
    let mut coll_r = vec![0.0; n];
    for i in 0..n {
        charge[i] = -repulsion.abs() * 6.0 * (radii[i] / 5.0).sqrt();
        coll_r[i] = radii[i] * 1.5 + 2.0;
    }

    let intra = Links::build(&intra_pairs, n, node_distance, INTRA_STRENGTH);
    let inter = Links::build(&inter_pairs, n, effective_cluster_distance, INTER_STRENGTH);

    let mut sim = Sim {
        n,
        nodes,
        communities,
        charge,
        coll_r,
        intra,
        inter,
        cohesion,
        spread_factor,
        rng: Lcg::new(),
    };

    let log_alpha_min = ALPHA_MIN.ln();
    let report = |it: usize, alpha: f64| {
        if let Some(f) = progress {
            // Same 0..1000 progress as layout-core: the further along of
            // alpha decay and the iteration cap.
            let by_alpha = if alpha <= ALPHA_MIN {
                1.0
            } else {
                (alpha.ln() / log_alpha_min).max(0.0)
            };
            let by_iter = it as f64 / MAX_TICKS as f64;
            let p = by_alpha.max(by_iter).clamp(0.0, 1.0);
            let _ = f.call2(
                &wasm_bindgen::JsValue::NULL,
                &wasm_bindgen::JsValue::from_f64((p * 1000.0).round()),
                &wasm_bindgen::JsValue::from_f64(1000.0),
            );
        }
    };

    let mut alpha = 1.0f64;
    let mut it = 0usize;
    let mut quiet = 0usize;
    let mut prev_x = sim.nodes.x.clone();
    let mut prev_y = sim.nodes.y.clone();
    while it < MAX_TICKS {
        let end = (it + BATCH).min(MAX_TICKS);
        while it < end {
            // d3 decays alpha at the *start* of each tick, before forces.
            alpha += (ALPHA_TARGET - alpha) * ALPHA_DECAY;
            sim.tick(alpha);
            it += 1;
        }
        if (sim.spread_factor - 1.0).abs() > f64::EPSILON {
            apply_cluster_spread(&mut sim);
        }
        report(it, alpha);

        // Quiescence: furthest net node move over this batch vs RMS scale.
        let mut sum_r2 = 0.0f64;
        let mut max_move2 = 0.0f64;
        for i in 0..n {
            let x = sim.nodes.x[i];
            let y = sim.nodes.y[i];
            sum_r2 += x * x + y * y;
            let dx = x - prev_x[i];
            let dy = y - prev_y[i];
            let m2 = dx * dx + dy * dy;
            if m2 > max_move2 {
                max_move2 = m2;
            }
        }
        let scale = (sum_r2 / n.max(1) as f64).sqrt().max(1.0);
        if max_move2.sqrt() < QUIET_REL * scale {
            quiet += 1;
            if quiet >= QUIET_WINDOWS {
                break;
            }
        } else {
            quiet = 0;
        }
        prev_x.copy_from_slice(&sim.nodes.x);
        prev_y.copy_from_slice(&sim.nodes.y);

        if alpha <= ALPHA_MIN {
            break;
        }
    }
    report(MAX_TICKS, ALPHA_MIN);

    let mut out = vec![0.0f32; n * 2];
    for i in 0..n {
        out[2 * i] = sim.nodes.x[i] as f32;
        out[2 * i + 1] = sim.nodes.y[i] as f32;
    }
    out
}

/// Resident graph session: the user's JSON crosses into WASM **once**,
/// then everything expensive (parse, Louvain, radii, cycle/orphan,
/// layout) runs in Rust and the JS side drives it with cheap queries.
/// `set_resolution` re-clusters in place; `layout(warm=true)` re-relaxes
/// from the current positions instead of reseeding (instant-feel slider
/// tweaks).
#[wasm_bindgen]
pub struct GraphSession {
    parsed: graph::ParsedGraph,
    communities: Vec<i32>,
    radii: Vec<f64>,
    resolution: f64,
    last_positions: Option<Vec<f32>>,
}

#[wasm_bindgen]
impl GraphSession {
    /// Parse + radii + Louvain (resolution 1). The big JSON is consumed
    /// here and never crosses the worker boundary again.
    pub fn load(json: &str) -> Result<GraphSession, JsValue> {
        let parsed = graph::parse(json).map_err(|e| JsValue::from_str(&e))?;
        let radii: Vec<f64> = graph::compute_radii(&parsed.in_degree, &parsed.out_degree)
            .iter()
            .map(|&v| v as f64)
            .collect();
        let communities = graph::louvain(parsed.ids.len(), &parsed.edges_flat, 1.0);
        Ok(GraphSession {
            parsed,
            communities,
            radii,
            resolution: 1.0,
            last_positions: None,
        })
    }

    pub fn node_count(&self) -> usize {
        self.parsed.ids.len()
    }

    /// One-time transfer of node ids (selection mapping lives in JS).
    pub fn ids_json(&self) -> String {
        serde_json::to_string(&self.parsed.ids).unwrap_or_else(|_| "[]".into())
    }

    /// Flat (from,to,…) edges — one transfer for the renderer.
    pub fn edges_flat(&self) -> Vec<i32> {
        self.parsed.edges_flat.clone()
    }

    pub fn communities(&self) -> Vec<i32> {
        self.communities.clone()
    }

    pub fn radii(&self) -> Vec<f32> {
        self.radii.iter().map(|&v| v as f32).collect()
    }

    /// Re-cluster only (graph already resident) — what the resolution
    /// slider needs, instead of re-parsing + re-marshaling.
    pub fn set_resolution(&mut self, resolution: f64) {
        if (resolution - self.resolution).abs() < f64::EPSILON {
            return;
        }
        self.resolution = resolution;
        self.communities =
            graph::louvain(self.parsed.ids.len(), &self.parsed.edges_flat, resolution);
    }

    /// Override the community assignment with one computed on the JS side
    /// (the label-prefix clustering mode, which has no Louvain analogue).
    /// Indexed 0..node_count-1, same node order as `ids_json`. Extra or
    /// missing entries are clamped to the resident node count.
    pub fn set_communities(&mut self, communities: &[i32]) {
        let n = self.parsed.ids.len();
        let mut next = vec![0i32; n];
        let take = communities.len().min(n);
        next[..take].copy_from_slice(&communities[..take]);
        self.communities = next;
    }

    /// `hidden_edge_type_ids`: edge-type ids the user has filtered out
    /// (empty = none). Same semantics as the JS `hasAnyCycle`.
    pub fn has_any_cycle(&self, hidden_edge_type_ids: &[i32]) -> bool {
        let hidden = self.hidden_type_mask(hidden_edge_type_ids);
        graph::has_any_cycle(
            self.parsed.ids.len(),
            &self.parsed.edges_flat,
            &self.parsed.edge_type_ids,
            hidden.as_deref(),
        )
    }

    /// All elementary directed cycles (Tarjan SCC + Johnson's, the
    /// exponential-worst-case enumeration), as a flat buffer:
    /// `[len0, n0_0, n0_1, …, len1, n1_0, …]`. Node indices,
    /// `hidden_edge_type_ids` restricts to visible edges, `max_cycles`
    /// caps the (potentially exponential) enumeration.
    ///
    /// **`node_remap`** is critical for type-hide flows. When non-empty
    /// it must be a per-node `i32` array (length == node count): visible
    /// nodes map to themselves, hidden nodes to their nearest visible
    /// owner, unmappable nodes to `-1`. With a remap supplied the CSR is
    /// built on the *contracted* graph, so the enumeration finds cycles
    /// between visible reps directly — and the `max_cycles` cap then
    /// bounds *bundled* cycles, not raw ones. Without this, a graph
    /// whose first 1000 raw cycles all live inside a single package's
    /// file SCC would surface zero package-level cycles even when the
    /// contracted graph has many; see the do-not-commit.json
    /// regression. Pass empty `&[i32]` for the original raw behavior.
    pub fn raw_cycles(
        &self,
        hidden_edge_type_ids: &[i32],
        node_remap: &[i32],
        max_cycles: usize,
    ) -> Vec<i32> {
        let hidden = self.hidden_type_mask(hidden_edge_type_ids);
        let remap = if node_remap.is_empty() { None } else { Some(node_remap) };
        let cycles = graph::find_all_cycles(
            self.parsed.ids.len(),
            &self.parsed.edges_flat,
            &self.parsed.edge_type_ids,
            remap,
            hidden.as_deref(),
            max_cycles,
        );
        let mut flat = Vec::new();
        for c in &cycles {
            flat.push(c.len() as i32);
            flat.extend_from_slice(c);
        }
        flat
    }

    /// Boolean mask over edge-type ids: `mask[t] == true` ⇒ edges of
    /// type `t` are hidden. Empty input ⇒ no filter (`None`).
    fn hidden_type_mask(&self, hidden_edge_type_ids: &[i32]) -> Option<Vec<bool>> {
        if hidden_edge_type_ids.is_empty() {
            return None;
        }
        let mut mask = vec![false; self.parsed.edge_type_names.len()];
        for &t in hidden_edge_type_ids {
            if let Some(slot) = mask.get_mut(t as usize) {
                *slot = true;
            }
        }
        Some(mask)
    }

    /// Boolean mask over node indices for the user's declared roots.
    /// Empty input ⇒ no roots (`None`).
    fn root_mask(&self, root_indices: &[i32]) -> Option<Vec<bool>> {
        if root_indices.is_empty() {
            return None;
        }
        let mut mask = vec![false; self.parsed.ids.len()];
        for &i in root_indices {
            if let Some(slot) = mask.get_mut(i as usize) {
                *slot = true;
            }
        }
        Some(mask)
    }

    /// `hidden_edge_type_ids`: edge-type ids the user has filtered out
    /// (empty = none). Same semantics as the JS `hasAnyOrphan`.
    pub fn has_any_orphan(&self, hidden_edge_type_ids: &[i32]) -> bool {
        let hidden = self.hidden_type_mask(hidden_edge_type_ids);
        graph::has_any_orphan(
            self.parsed.ids.len(),
            &self.parsed.edges_flat,
            &self.parsed.edge_type_ids,
            &self.parsed.in_degree,
            hidden.as_deref(),
        )
    }

    /// Transitively-orphaned node indices. `hidden_edge_type_ids`
    /// restricts to visible edges; `root_indices` are never peeled.
    /// Both empty = the unfiltered analysis. Same semantics as the JS
    /// `findOrphans`.
    pub fn find_orphans(&self, hidden_edge_type_ids: &[i32], root_indices: &[i32]) -> Vec<i32> {
        let hidden = self.hidden_type_mask(hidden_edge_type_ids);
        let roots = self.root_mask(root_indices);
        graph::find_orphans(
            self.parsed.ids.len(),
            &self.parsed.edges_flat,
            &self.parsed.edge_type_ids,
            &self.parsed.in_degree,
            hidden.as_deref(),
            roots.as_deref(),
        )
    }

    /// Run the layout on the resident graph. `warm` re-relaxes from the
    /// last result (slider tweak) instead of reseeding. Returns and
    /// stores the flat positions buffer.
    #[allow(clippy::too_many_arguments)]
    pub fn layout(
        &mut self,
        spread_factor: f64,
        repulsion: f64,
        node_distance: f64,
        cluster_distance: f64,
        cohesion: f64,
        warm: bool,
        progress: Option<js_sys::Function>,
    ) -> Vec<f32> {
        let warm_seed = if warm { self.last_positions.as_deref() } else { None };
        let out = simulate(
            self.parsed.ids.len(),
            &self.parsed.edges_flat,
            &self.communities,
            &self.radii,
            spread_factor,
            repulsion,
            node_distance,
            cluster_distance,
            cohesion,
            warm_seed,
            progress.as_ref(),
        );
        self.last_positions = Some(out.clone());
        out
    }
}

impl Sim {
    fn tick(&mut self, alpha: f64) {
        // Force order matches layout-core's Map insertion order:
        // charge → collide → intraLink → interLink → center → cohesion.
        self.force_many_body(alpha);
        for _ in 0..COLLIDE_ITERATIONS {
            self.force_collide();
        }
        self.force_link_intra(alpha);
        self.force_link_inter(alpha);
        self.force_center();
        self.force_cohesion(alpha);

        // Integrate: x += vx *= velocityDecay (no fixed nodes here).
        for i in 0..self.n {
            self.nodes.vx[i] *= VELOCITY_DECAY;
            self.nodes.x[i] += self.nodes.vx[i];
            self.nodes.vy[i] *= VELOCITY_DECAY;
            self.nodes.y[i] += self.nodes.vy[i];
        }
    }

    fn force_center(&mut self) {
        let n = self.n as f64;
        let mut sx = 0.0;
        let mut sy = 0.0;
        for i in 0..self.n {
            sx += self.nodes.x[i];
            sy += self.nodes.y[i];
        }
        sx = (sx / n) * CENTER_STRENGTH;
        sy = (sy / n) * CENTER_STRENGTH;
        for i in 0..self.n {
            self.nodes.x[i] -= sx;
            self.nodes.y[i] -= sy;
        }
    }

    fn force_cohesion(&mut self, alpha: f64) {
        let strength = self.cohesion;
        if strength <= 0.0 || self.n == 0 {
            return;
        }
        let mut max_comm = 0i64;
        for &c in &self.communities {
            if c as i64 > max_comm {
                max_comm = c as i64;
            }
        }
        let cap = ((max_comm + 1) as usize).min(MAX_INDEXED_COMM);
        let mut sum_x = vec![0.0f64; cap];
        let mut sum_y = vec![0.0f64; cap];
        let mut counts = vec![0i32; cap];
        for i in 0..self.n {
            let c = self.communities[i];
            if c < 0 || c as usize >= cap {
                continue;
            }
            sum_x[c as usize] += self.nodes.x[i];
            sum_y[c as usize] += self.nodes.y[i];
            counts[c as usize] += 1;
        }
        for i in 0..self.n {
            let c = self.communities[i];
            if c < 0 || c as usize >= cap {
                continue;
            }
            let k = counts[c as usize];
            if k <= 1 {
                continue;
            }
            let cx = sum_x[c as usize] / k as f64;
            let cy = sum_y[c as usize] / k as f64;
            self.nodes.vx[i] += (cx - self.nodes.x[i]) * strength * alpha;
            self.nodes.vy[i] += (cy - self.nodes.y[i]) * strength * alpha;
        }
    }

    fn force_link_intra(&mut self, alpha: f64) {
        force_link(&mut self.nodes, &self.intra, alpha, &mut self.rng);
    }

    fn force_link_inter(&mut self, alpha: f64) {
        force_link(&mut self.nodes, &self.inter, alpha, &mut self.rng);
    }

    fn force_many_body(&mut self, alpha: f64) {
        let n = self.n;
        if n == 0 {
            return;
        }
        let idx: Vec<i32> = (0..n as i32).collect();
        let mut tree = BHTree::build(&self.nodes.x, &self.nodes.y, &idx, n);
        tree.accumulate(&self.charge);
        for i in 0..n {
            tree.apply(
                i,
                self.nodes.x[i],
                self.nodes.y[i],
                alpha,
                &self.charge,
                &mut self.nodes.vx,
                &mut self.nodes.vy,
                &mut self.rng,
            );
        }
    }

    fn force_collide(&mut self) {
        let n = self.n;
        if n == 0 {
            return;
        }
        // Quadtree is built on (x + vx, y + vy).
        let mut px = vec![0.0; n];
        let mut py = vec![0.0; n];
        for i in 0..n {
            px[i] = self.nodes.x[i] + self.nodes.vx[i];
            py[i] = self.nodes.y[i] + self.nodes.vy[i];
        }
        let idx: Vec<i32> = (0..n as i32).collect();
        let mut tree = BHTree::build(&px, &py, &idx, n);
        tree.prepare_radii(&self.coll_r);
        for i in 0..n {
            let ri = self.coll_r[i];
            let ri2 = ri * ri;
            let xi = self.nodes.x[i] + self.nodes.vx[i];
            let yi = self.nodes.y[i] + self.nodes.vy[i];
            tree.apply_collide(
                i,
                xi,
                yi,
                ri,
                ri2,
                &self.coll_r,
                &px,
                &py,
                &mut self.nodes.vx,
                &mut self.nodes.vy,
                &mut self.rng,
            );
        }
    }
}

/// d3-force `link.js`, with constant strength/distance (the JS passes
/// `.strength(0.5|0.12)` and `.distance(...)`), `iterations = 1`.
fn force_link(nodes: &mut Nodes, links: &Links, alpha: f64, rng: &mut Lcg) {
    for k in 0..links.src.len() {
        let s = links.src[k];
        let t = links.tgt[k];
        let mut x = nodes.x[t] + nodes.vx[t] - nodes.x[s] - nodes.vx[s];
        if x == 0.0 {
            x = rng.jiggle();
        }
        let mut y = nodes.y[t] + nodes.vy[t] - nodes.y[s] - nodes.vy[s];
        if y == 0.0 {
            y = rng.jiggle();
        }
        let mut l = (x * x + y * y).sqrt();
        l = (l - links.distance) / l * alpha * links.strength;
        let xl = x * l;
        let yl = y * l;
        let b = links.bias[k];
        nodes.vx[t] -= xl * b;
        nodes.vy[t] -= yl * b;
        let b1 = 1.0 - b;
        nodes.vx[s] += xl * b1;
        nodes.vy[s] += yl * b1;
    }
}

// --------------------------------------------------------------------------
// Barnes-Hut tree (carries point coords so coincidence + traversal match d3)
// --------------------------------------------------------------------------

struct BHTree {
    child: Vec<[u32; 4]>,
    point: Vec<i32>,
    leaf: Vec<bool>,
    x0: Vec<f64>,
    y0: Vec<f64>,
    len: Vec<f64>,
    value: Vec<f64>,
    cx: Vec<f64>,
    cy: Vec<f64>,
    r: Vec<f64>,
    next: Vec<i32>,
    px: Vec<f64>,
    py: Vec<f64>,
    root: u32,
}

impl BHTree {
    fn new_cell(&mut self, x0: f64, y0: f64, len: f64, leaf: bool) -> u32 {
        let i = self.child.len() as u32;
        self.child.push([NONE; 4]);
        self.point.push(-1);
        self.leaf.push(leaf);
        self.x0.push(x0);
        self.y0.push(y0);
        self.len.push(len);
        self.value.push(0.0);
        self.cx.push(0.0);
        self.cy.push(0.0);
        self.r.push(0.0);
        i
    }

    fn build(px: &[f64], py: &[f64], idx: &[i32], n: usize) -> Self {
        let mut t = BHTree {
            child: Vec::with_capacity(2 * n + 1),
            point: Vec::with_capacity(2 * n + 1),
            leaf: Vec::with_capacity(2 * n + 1),
            x0: Vec::with_capacity(2 * n + 1),
            y0: Vec::with_capacity(2 * n + 1),
            len: Vec::with_capacity(2 * n + 1),
            value: Vec::with_capacity(2 * n + 1),
            cx: Vec::with_capacity(2 * n + 1),
            cy: Vec::with_capacity(2 * n + 1),
            r: Vec::with_capacity(2 * n + 1),
            next: vec![-1; n],
            px: px.to_vec(),
            py: py.to_vec(),
            root: NONE,
        };
        if idx.is_empty() {
            return t;
        }
        let mut minx = f64::INFINITY;
        let mut miny = f64::INFINITY;
        let mut maxx = f64::NEG_INFINITY;
        let mut maxy = f64::NEG_INFINITY;
        for &p in idx {
            let p = p as usize;
            minx = minx.min(px[p]);
            miny = miny.min(py[p]);
            maxx = maxx.max(px[p]);
            maxy = maxy.max(py[p]);
        }
        let side = (maxx - minx).max(maxy - miny).max(1e-6);
        let root = t.new_cell(minx, miny, side, true);
        t.root = root;
        for &p in idx {
            t.insert(root, p);
        }
        t
    }

    fn insert(&mut self, root: u32, p: i32) {
        let x = self.px[p as usize];
        let y = self.py[p as usize];
        let mut cell = root;
        let mut depth = 0u32;
        loop {
            if self.leaf[cell as usize] {
                let existing = self.point[cell as usize];
                if existing < 0 {
                    self.point[cell as usize] = p;
                    return;
                }
                let ex = self.px[existing as usize];
                let ey = self.py[existing as usize];
                if (ex == x && ey == y) || depth >= MAX_DEPTH {
                    let mut tail = existing;
                    while self.next[tail as usize] >= 0 {
                        tail = self.next[tail as usize];
                    }
                    self.next[tail as usize] = p;
                    return;
                }
                self.leaf[cell as usize] = false;
                self.point[cell as usize] = -1;
                self.descend_insert(cell, existing, ex, ey);
            }
            let x0 = self.x0[cell as usize];
            let y0 = self.y0[cell as usize];
            let half = self.len[cell as usize] * 0.5;
            let xm = x0 + half;
            let ym = y0 + half;
            let qi = (((y >= ym) as usize) << 1) | (x >= xm) as usize;
            if self.child[cell as usize][qi] == NONE {
                let cx0 = if x >= xm { xm } else { x0 };
                let cy0 = if y >= ym { ym } else { y0 };
                let leafc = self.new_cell(cx0, cy0, half, true);
                self.point[leafc as usize] = p;
                self.child[cell as usize][qi] = leafc;
                return;
            }
            cell = self.child[cell as usize][qi];
            depth += 1;
        }
    }

    fn descend_insert(&mut self, cell: u32, p: i32, x: f64, y: f64) {
        let x0 = self.x0[cell as usize];
        let y0 = self.y0[cell as usize];
        let half = self.len[cell as usize] * 0.5;
        let xm = x0 + half;
        let ym = y0 + half;
        let qi = (((y >= ym) as usize) << 1) | (x >= xm) as usize;
        if self.child[cell as usize][qi] == NONE {
            let cx0 = if x >= xm { xm } else { x0 };
            let cy0 = if y >= ym { ym } else { y0 };
            let leafc = self.new_cell(cx0, cy0, half, true);
            self.point[leafc as usize] = p;
            self.child[cell as usize][qi] = leafc;
        } else {
            let c = self.child[cell as usize][qi];
            // Existing child is always a leaf or internal cell; recurse.
            self.insert(c, p);
        }
    }

    /// d3 manyBody `accumulate` (visitAfter / post-order).
    fn accumulate(&mut self, strengths: &[f64]) {
        if self.root == NONE {
            return;
        }
        self.accumulate_cell(self.root, strengths);
    }

    fn accumulate_cell(&mut self, cell: u32, strengths: &[f64]) {
        let c = cell as usize;
        if self.leaf[c] {
            let p = self.point[c];
            if p < 0 {
                self.value[c] = 0.0;
                return;
            }
            self.cx[c] = self.px[p as usize];
            self.cy[c] = self.py[p as usize];
            let mut s = 0.0;
            let mut q = p;
            while q >= 0 {
                s += strengths[q as usize];
                q = self.next[q as usize];
            }
            self.value[c] = s;
            return;
        }
        let mut strength = 0.0;
        let mut weight = 0.0;
        let mut x = 0.0;
        let mut y = 0.0;
        for k in 0..4 {
            let ch = self.child[c][k];
            if ch != NONE {
                self.accumulate_cell(ch, strengths);
                let v = self.value[ch as usize];
                let cabs = v.abs();
                if cabs != 0.0 {
                    strength += v;
                    weight += cabs;
                    x += cabs * self.cx[ch as usize];
                    y += cabs * self.cy[ch as usize];
                }
            }
        }
        if weight != 0.0 {
            self.cx[c] = x / weight;
            self.cy[c] = y / weight;
        }
        self.value[c] = strength;
    }

    /// d3 manyBody `apply` for one node, pre-order with the theta cutoff.
    #[allow(clippy::too_many_arguments)]
    fn apply(
        &self,
        node: usize,
        nx: f64,
        ny: f64,
        alpha: f64,
        strengths: &[f64],
        vx: &mut [f64],
        vy: &mut [f64],
        rng: &mut Lcg,
    ) {
        if self.root == NONE {
            return;
        }
        // Explicit stack: (cell, cell_width).
        let mut stack: Vec<(u32, f64)> = Vec::with_capacity(64);
        stack.push((self.root, self.len[self.root as usize]));
        while let Some((cell, w)) = stack.pop() {
            let c = cell as usize;
            let value = self.value[c];
            if value == 0.0 {
                continue;
            }
            let mut x = self.cx[c] - nx;
            let mut y = self.cy[c] - ny;
            let mut l = x * x + y * y;
            // Barnes-Hut: w*w / theta2 < l  → treat cell as a point mass.
            if w * w / THETA2 < l {
                if x == 0.0 {
                    x = rng.jiggle();
                    l += x * x;
                }
                if y == 0.0 {
                    y = rng.jiggle();
                    l += y * y;
                }
                if l < DISTANCE_MIN2 {
                    l = (DISTANCE_MIN2 * l).sqrt();
                }
                vx[node] += x * value * alpha / l;
                vy[node] += y * value * alpha / l;
                continue;
            }
            if !self.leaf[c] {
                // Too close to approximate: descend.
                for k in 0..4 {
                    let ch = self.child[c][k];
                    if ch != NONE {
                        stack.push((ch, w * 0.5));
                    }
                }
                continue;
            }
            // Leaf: apply each coincident point directly.
            let head = self.point[c];
            if head < 0 {
                continue;
            }
            let chained = self.next[head as usize] >= 0;
            if head as usize != node || chained {
                if x == 0.0 {
                    x = rng.jiggle();
                    l += x * x;
                }
                if y == 0.0 {
                    y = rng.jiggle();
                    l += y * y;
                }
                if l < DISTANCE_MIN2 {
                    l = (DISTANCE_MIN2 * l).sqrt();
                }
            }
            let mut q = head;
            while q >= 0 {
                if q as usize != node {
                    let wv = strengths[q as usize] * alpha / l;
                    vx[node] += x * wv;
                    vy[node] += y * wv;
                }
                q = self.next[q as usize];
            }
        }
    }

    /// d3 collide `prepare` (visitAfter): cell radius = max child/point r.
    fn prepare_radii(&mut self, radii: &[f64]) {
        if self.root == NONE {
            return;
        }
        self.prepare_cell(self.root, radii);
    }

    fn prepare_cell(&mut self, cell: u32, radii: &[f64]) -> f64 {
        let c = cell as usize;
        if self.leaf[c] {
            let p = self.point[c];
            let r = if p < 0 { 0.0 } else { radii[p as usize] };
            self.r[c] = r;
            return r;
        }
        let mut maxr = 0.0;
        for k in 0..4 {
            let ch = self.child[c][k];
            if ch != NONE {
                let cr = self.prepare_cell(ch, radii);
                if cr > maxr {
                    maxr = cr;
                }
            }
        }
        self.r[c] = maxr;
        maxr
    }

    /// d3 collide `apply` for one node. Pairs are de-duplicated by only
    /// resolving when `other.index > node.index`; the chain is *not*
    /// walked (matching d3-quadtree's collide, which only touches
    /// `quad.data`).
    #[allow(clippy::too_many_arguments)]
    fn apply_collide(
        &self,
        node: usize,
        xi: f64,
        yi: f64,
        ri: f64,
        ri2: f64,
        radii: &[f64],
        px: &[f64],
        py: &[f64],
        vx: &mut [f64],
        vy: &mut [f64],
        rng: &mut Lcg,
    ) {
        if self.root == NONE {
            return;
        }
        let mut stack: Vec<u32> = Vec::with_capacity(64);
        stack.push(self.root);
        while let Some(cell) = stack.pop() {
            let c = cell as usize;
            let rj_cell = self.r[c];
            let r = ri + rj_cell;
            if self.leaf[c] {
                let p = self.point[c];
                if p < 0 {
                    continue;
                }
                let other = p as usize;
                if other > node {
                    let rj = radii[other];
                    let rr = ri + rj;
                    let mut x = xi - px[other];
                    let mut y = yi - py[other];
                    let mut l = x * x + y * y;
                    if l < rr * rr {
                        if x == 0.0 {
                            x = rng.jiggle();
                            l += x * x;
                        }
                        if y == 0.0 {
                            y = rng.jiggle();
                            l += y * y;
                        }
                        let ls = l.sqrt();
                        let factor = (rr - ls) / ls * COLLIDE_STRENGTH;
                        x *= factor;
                        y *= factor;
                        let rj2 = rj * rj;
                        let ratio = rj2 / (ri2 + rj2);
                        vx[node] += x * ratio;
                        vy[node] += y * ratio;
                        let inv = 1.0 - ratio;
                        vx[other] -= x * inv;
                        vy[other] -= y * inv;
                    }
                }
                continue;
            }
            // Internal: cull if the node's circle can't reach this cell.
            let x0 = self.x0[c];
            let y0 = self.y0[c];
            let side = self.len[c];
            let x1 = x0 + side;
            let y1 = y0 + side;
            if x0 > xi + r || x1 < xi - r || y0 > yi + r || y1 < yi - r {
                continue;
            }
            for k in 0..4 {
                let ch = self.child[c][k];
                if ch != NONE {
                    stack.push(ch);
                }
            }
        }
    }
}

// --------------------------------------------------------------------------
// Seeding + cluster spread (ports of layout-core.ts helpers)
// --------------------------------------------------------------------------

fn seed_by_community(nodes: &mut Nodes, communities: &[i32], radii: &[f64]) {
    let n = nodes.x.len();
    use std::collections::HashMap;
    let mut counts: HashMap<i32, usize> = HashMap::new();
    let mut radii_sum: HashMap<i32, f64> = HashMap::new();
    for i in 0..n {
        let c = communities[i];
        *counts.entry(c).or_insert(0) += 1;
        *radii_sum.entry(c).or_insert(0.0) += radii[i];
    }
    // Keys sorted by descending count (stable order isn't guaranteed in JS
    // for ties either; the layout is robust to that).
    let mut keys: Vec<i32> = counts.keys().copied().collect();
    keys.sort_by(|a, b| counts[b].cmp(&counts[a]));

    let total = n as f64;
    let mut seed_radii: HashMap<i32, f64> = HashMap::new();
    for &c in &keys {
        let count = counts[&c] as f64;
        let avg_r = radii_sum[&c] / count;
        seed_radii.insert(c, count.sqrt() * (avg_r * 1.5 + 2.0));
    }
    let mut seed_radii_total = 0.0;
    for &v in seed_radii.values() {
        seed_radii_total += v;
    }
    let big_r = (total.sqrt() * 18.0).max(seed_radii_total * 0.8);

    let mut centroids: HashMap<i32, (f64, f64)> = HashMap::new();
    let mut acc = 0.0;
    for (k, &c) in keys.iter().enumerate() {
        let t = acc / total;
        let angle = k as f64 * GOLDEN_ANGLE;
        let radius = big_r * (t + 0.02).sqrt();
        centroids.insert(c, (angle.cos() * radius, angle.sin() * radius));
        acc += counts[&c] as f64;
    }

    let mut index_in_community: HashMap<i32, usize> = HashMap::new();
    for i in 0..n {
        let c = communities[i];
        let (cx, cy) = centroids[&c];
        let count = counts[&c] as f64;
        let seed_r = seed_radii[&c];
        let k = *index_in_community.get(&c).unwrap_or(&0);
        index_in_community.insert(c, k + 1);
        let t = (k as f64 + 0.5) / count;
        let local_r = seed_r * t.sqrt();
        let local_angle = k as f64 * GOLDEN_ANGLE;
        nodes.x[i] = cx + local_angle.cos() * local_r;
        nodes.y[i] = cy + local_angle.sin() * local_r;
    }
}

fn apply_cluster_spread(sim: &mut Sim) {
    let n = sim.n;
    let mut max_comm = 0i64;
    for &c in &sim.communities {
        if c as i64 > max_comm {
            max_comm = c as i64;
        }
    }
    let cap = ((max_comm + 1) as usize).min(MAX_INDEXED_COMM);
    let mut sum_x = vec![0.0f64; cap];
    let mut sum_y = vec![0.0f64; cap];
    let mut counts = vec![0i32; cap];
    let mut gx = 0.0;
    let mut gy = 0.0;
    for i in 0..n {
        let x = sim.nodes.x[i];
        let y = sim.nodes.y[i];
        let c = sim.communities[i];
        gx += x;
        gy += y;
        if c < 0 || c as usize >= cap {
            continue;
        }
        sum_x[c as usize] += x;
        sum_y[c as usize] += y;
        counts[c as usize] += 1;
    }
    gx /= n as f64;
    gy /= n as f64;
    let sf = sim.spread_factor;
    let mut shift_x = vec![0.0f64; cap];
    let mut shift_y = vec![0.0f64; cap];
    for c in 0..cap {
        let k = counts[c];
        if k == 0 {
            continue;
        }
        shift_x[c] = (sf - 1.0) * (sum_x[c] / k as f64 - gx);
        shift_y[c] = (sf - 1.0) * (sum_y[c] / k as f64 - gy);
    }
    for i in 0..n {
        let c = sim.communities[i];
        if c < 0 || c as usize >= cap {
            continue;
        }
        sim.nodes.x[i] += shift_x[c as usize];
        sim.nodes.y[i] += shift_y[c as usize];
    }
}
