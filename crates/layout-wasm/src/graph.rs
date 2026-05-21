//! Rust port of the JS data pipeline: `schema.ts`/`parser.ts`
//! (`parseGraphJson` → LoadedGraph), `pack.ts` `computeRadii`, and the
//! Louvain community detection currently in `analyze.worker.ts`
//! (graphology). Behavioral match on the structural bits (dedup, drop
//! unknown/self, intern order, degree); Louvain is a standard modularity
//! optimizer — communities only need to be *good*, not byte-identical to
//! graphology.

use std::collections::{BTreeMap, HashMap};

/// Parsed graph, the Rust analogue of `LoadedGraph` (minus the graphology
/// instance — Louvain runs directly on the edge list here).
pub struct ParsedGraph {
    pub ids: Vec<String>,
    pub labels: Vec<String>,
    pub node_type_names: Vec<String>,
    pub node_type_ids: Vec<i32>,
    /// flat (from, to, from, to, …)
    pub edges_flat: Vec<i32>,
    pub edge_type_names: Vec<String>,
    pub edge_type_ids: Vec<i32>,
    pub in_degree: Vec<i32>,
    pub out_degree: Vec<i32>,
}

/// `String(value)` the way the JS parser coerces ids: strings pass
/// through, integral numbers print without a decimal, everything else
/// uses serde_json's rendering.
fn coerce_id(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(i.to_string())
            } else if let Some(u) = n.as_u64() {
                Some(u.to_string())
            } else {
                Some(n.to_string())
            }
        }
        _ => None,
    }
}

/// Port of `parseGraphJson` + `buildLoadedGraph` (schema validation is
/// folded in as `Err` returns). Edges that target an id missing from
/// the `nodes` list spawn a synthetic placeholder node with
/// `type == "missing"` and `label == id`; the JS parser does the same.
/// Self-loops are still dropped, and duplicate `(from, to)` pairs
/// collapse (first edgeType wins).
pub fn parse(json: &str) -> Result<ParsedGraph, String> {
    let root: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("Invalid JSON: {e}"))?;
    let nodes = root
        .get("nodes")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Top-level `nodes` must be an array.".to_string())?;

    let initial_n = nodes.len();
    let mut ids: Vec<String> = Vec::with_capacity(initial_n);
    let mut labels: Vec<String> = Vec::with_capacity(initial_n);
    let mut id_to_index: HashMap<String, i32> = HashMap::with_capacity(initial_n);

    let mut node_type_names: Vec<String> = vec![String::new()];
    let mut node_type_index: HashMap<String, i32> = HashMap::from([(String::new(), 0)]);
    let mut node_type_ids: Vec<i32> = Vec::with_capacity(initial_n);

    for (i, node) in nodes.iter().enumerate() {
        let obj = node
            .as_object()
            .ok_or_else(|| format!("nodes[{i}] is not an object."))?;
        let id = obj
            .get("id")
            .and_then(coerce_id)
            .ok_or_else(|| format!("nodes[{i}].id must be a string or number."))?;
        if id_to_index.contains_key(&id) {
            return Err(format!("Duplicate node id: {id}"));
        }
        id_to_index.insert(id.clone(), i as i32);
        let label = obj
            .get("label")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| id.clone());
        ids.push(id);
        labels.push(label);

        let tname = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let tid = *node_type_index.entry(tname.to_string()).or_insert_with(|| {
            node_type_names.push(tname.to_string());
            (node_type_names.len() - 1) as i32
        });
        node_type_ids.push(tid);
    }

    // Pre-intern the synthetic `missing` type so it lands in
    // `node_type_names` consistently even when the graph happens to
    // declare zero of them — matches the JS parser's behavior.
    let missing_type_id = *node_type_index
        .entry("missing".to_string())
        .or_insert_with(|| {
            node_type_names.push("missing".to_string());
            (node_type_names.len() - 1) as i32
        });

    let mut edge_type_names: Vec<String> = vec![String::new()];
    let mut edge_type_index: HashMap<String, i32> = HashMap::from([(String::new(), 0)]);

    // (from, to) dedupe — encode as `(i64 << 32) | j` so it stays
    // unique regardless of how many synthetic nodes we end up appending.
    let mut seen: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut flat: Vec<i32> = Vec::new();
    let mut edge_type_ids: Vec<i32> = Vec::new();

    for (i, node) in nodes.iter().enumerate() {
        let Some(edges) = node.get("edges").and_then(|v| v.as_array()) else {
            continue;
        };
        for e in edges {
            let (tid_str, type_name): (String, &str) = match e {
                serde_json::Value::String(_) | serde_json::Value::Number(_) => {
                    (coerce_id(e).unwrap(), "")
                }
                serde_json::Value::Object(o) => {
                    let nid = o
                        .get("nodeId")
                        .and_then(coerce_id)
                        .ok_or_else(|| format!("nodes[{i}].edges[].nodeId invalid"))?;
                    let et = o.get("edgeType").and_then(|v| v.as_str()).ok_or_else(|| {
                        format!("nodes[{i}].edges[].edgeType must be a string.")
                    })?;
                    (nid, et)
                }
                _ => return Err(format!("nodes[{i}].edges[] has an invalid entry.")),
            };
            // Unknown ids spawn a placeholder node on first sight; later
            // edges to the same id reuse the same index. The synthetic
            // node carries `type = "missing"` and `label = id`.
            let j = if let Some(&existing) = id_to_index.get(&tid_str) {
                existing
            } else {
                let idx = ids.len() as i32;
                id_to_index.insert(tid_str.clone(), idx);
                labels.push(tid_str.clone());
                ids.push(tid_str.clone());
                node_type_ids.push(missing_type_id);
                idx
            };
            if j == i as i32 {
                continue; // self-loop — dropped
            }
            let key = ((i as i64) << 32) | (j as i64);
            if !seen.insert(key) {
                continue; // duplicate (from,to)
            }
            flat.push(i as i32);
            flat.push(j);
            let etid = *edge_type_index
                .entry(type_name.to_string())
                .or_insert_with(|| {
                    edge_type_names.push(type_name.to_string());
                    (edge_type_names.len() - 1) as i32
                });
            edge_type_ids.push(etid);
        }
    }

    let final_n = ids.len();
    let mut in_degree = vec![0i32; final_n];
    let mut out_degree = vec![0i32; final_n];
    let mut k = 0;
    while k < flat.len() {
        out_degree[flat[k] as usize] += 1;
        in_degree[flat[k + 1] as usize] += 1;
        k += 2;
    }

    Ok(ParsedGraph {
        ids,
        labels,
        node_type_names,
        node_type_ids,
        edges_flat: flat,
        edge_type_names,
        edge_type_ids,
        in_degree,
        out_degree,
    })
}

/// Build outgoing CSR (`idx[N+1]`, `adj`) over the visible edges.
/// `hidden_edge_types[edgeTypeId] == true` filters an edge out.
fn build_out_csr(
    n: usize,
    edges_flat: &[i32],
    edge_type_ids: &[i32],
    hidden_edge_types: Option<&[bool]>,
) -> (Vec<i32>, Vec<i32>) {
    let e = edges_flat.len() / 2;
    let mut idx = vec![0i32; n + 1];
    let visible = |i: usize| match hidden_edge_types {
        Some(h) => {
            let t = edge_type_ids.get(i).copied().unwrap_or(0) as usize;
            !h.get(t).copied().unwrap_or(false)
        }
        None => true,
    };
    let mut count = 0usize;
    for i in 0..e {
        if !visible(i) {
            continue;
        }
        idx[edges_flat[2 * i] as usize + 1] += 1;
        count += 1;
    }
    for i in 0..n {
        idx[i + 1] += idx[i];
    }
    let mut adj = vec![0i32; count];
    let mut filled = vec![0i32; n];
    for i in 0..e {
        if !visible(i) {
            continue;
        }
        let a = edges_flat[2 * i] as usize;
        let b = edges_flat[2 * i + 1];
        adj[(idx[a] + filled[a]) as usize] = b;
        filled[a] += 1;
    }
    (idx, adj)
}

/// Port of `cycle.ts` `hasAnyCycle`: iterative coloured DFS, self-loops
/// are not cycles, a back edge into an on-stack node means a cycle.
pub fn has_any_cycle(
    n: usize,
    edges_flat: &[i32],
    edge_type_ids: &[i32],
    hidden_edge_types: Option<&[bool]>,
) -> bool {
    if n == 0 {
        return false;
    }
    let (idx, adj) = build_out_csr(n, edges_flat, edge_type_ids, hidden_edge_types);
    let mut color = vec![0u8; n]; // 0 unseen, 1 on-stack, 2 done
    let mut stack = vec![0i32; n];
    let mut cursor = vec![0i32; n];
    for start in 0..n {
        if color[start] != 0 {
            continue;
        }
        let mut depth = 0i32;
        stack[0] = start as i32;
        cursor[0] = idx[start];
        color[start] = 1;
        while depth >= 0 {
            let v = stack[depth as usize] as usize;
            let end = idx[v + 1];
            if cursor[depth as usize] >= end {
                color[v] = 2;
                depth -= 1;
                continue;
            }
            let j = cursor[depth as usize];
            let w = adj[j as usize];
            cursor[depth as usize] = j + 1;
            if w as usize == v {
                continue; // self-loop
            }
            match color[w as usize] {
                1 => return true,
                0 => {
                    depth += 1;
                    stack[depth as usize] = w;
                    cursor[depth as usize] = idx[w as usize];
                    color[w as usize] = 1;
                }
                _ => {}
            }
        }
    }
    false
}

/// Port of `orphans.ts` `findOrphans`: Kahn topological peel; nodes
/// whose ancestor set contains no cycle. `roots[i] == true` are never
/// peeled. Returns orphan node indices in peel order.
pub fn find_orphans(
    n: usize,
    edges_flat: &[i32],
    edge_type_ids: &[i32],
    in_degree: &[i32],
    hidden_edge_types: Option<&[bool]>,
    roots: Option<&[bool]>,
) -> Vec<i32> {
    if n == 0 {
        return Vec::new();
    }
    let e = edges_flat.len() / 2;
    let mut indeg: Vec<i32> = if hidden_edge_types.is_none() {
        in_degree.to_vec()
    } else {
        let h = hidden_edge_types.unwrap();
        let mut d = vec![0i32; n];
        for i in 0..e {
            let t = edge_type_ids.get(i).copied().unwrap_or(0) as usize;
            if h.get(t).copied().unwrap_or(false) {
                continue;
            }
            d[edges_flat[2 * i + 1] as usize] += 1;
        }
        d
    };
    let (idx, adj) = build_out_csr(n, edges_flat, edge_type_ids, hidden_edge_types);
    let is_root = |i: usize| roots.map(|r| r.get(i).copied().unwrap_or(false)).unwrap_or(false);
    let mut orphans = Vec::new();
    let mut queue = Vec::new();
    for i in 0..n {
        if indeg[i] == 0 && !is_root(i) {
            queue.push(i as i32);
        }
    }
    let mut head = 0;
    while head < queue.len() {
        let u = queue[head] as usize;
        head += 1;
        orphans.push(u as i32);
        for j in idx[u]..idx[u + 1] {
            let v = adj[j as usize] as usize;
            indeg[v] -= 1;
            if indeg[v] == 0 && !is_root(v) {
                queue.push(v as i32);
            }
        }
    }
    orphans
}

/// Port of `orphans.ts` `hasAnyOrphan`: any node with no visible
/// incoming edge.
pub fn has_any_orphan(
    n: usize,
    edges_flat: &[i32],
    edge_type_ids: &[i32],
    in_degree: &[i32],
    hidden_edge_types: Option<&[bool]>,
) -> bool {
    if n == 0 {
        return false;
    }
    match hidden_edge_types {
        None => in_degree.iter().any(|&d| d == 0),
        Some(h) => {
            let e = edges_flat.len() / 2;
            let mut has_in = vec![false; n];
            for i in 0..e {
                let t = edge_type_ids.get(i).copied().unwrap_or(0) as usize;
                if h.get(t).copied().unwrap_or(false) {
                    continue;
                }
                has_in[edges_flat[2 * i + 1] as usize] = true;
            }
            has_in.iter().any(|&v| !v)
        }
    }
}

/// Port of `pack.ts` `computeRadii`: `max(5, 2 + 1.6·√max(in,out))`.
pub fn compute_radii(in_degree: &[i32], out_degree: &[i32]) -> Vec<f32> {
    in_degree
        .iter()
        .zip(out_degree)
        .map(|(&i, &o)| {
            let deg = i.max(o) as f32;
            (2.0 + 1.6 * deg.sqrt()).max(5.0)
        })
        .collect()
}

/// Undirected, weighted Louvain modularity optimization with a
/// resolution parameter (γ). Edges are treated as undirected weight-1
/// (already deduped by the parser). Returns a community id per node,
/// renumbered 0..k. Replaces graphology-communities-louvain.
pub fn louvain(node_count: usize, edges_flat: &[i32], resolution: f64) -> Vec<i32> {
    let n = node_count;
    if n == 0 {
        return Vec::new();
    }
    // Level-0 weighted adjacency (symmetrized).
    let mut adj: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];
    let mut e = 0;
    while e + 1 < edges_flat.len() {
        let a = edges_flat[e] as usize;
        let b = edges_flat[e + 1] as usize;
        e += 2;
        if a == b {
            continue;
        }
        adj[a].push((b, 1.0));
        adj[b].push((a, 1.0));
    }

    // `node2comm[i]` = final community of original node i, tracked across
    // aggregation levels.
    let mut node2comm: Vec<usize> = (0..n).collect();
    let mut cur_adj = adj;
    let mut cur_n = n;
    let total_w: f64 = cur_adj.iter().flatten().map(|&(_, w)| w).sum::<f64>() / 2.0;
    if total_w == 0.0 {
        return (0..n as i32).collect();
    }
    let m2 = 2.0 * total_w;

    loop {
        let level_n = cur_n;
        let mut comm: Vec<usize> = (0..level_n).collect();
        let k: Vec<f64> = (0..level_n)
            .map(|i| cur_adj[i].iter().map(|&(_, w)| w).sum())
            .collect();
        let mut sigma_tot = k.clone();
        let self_loop: Vec<f64> = (0..level_n)
            .map(|i| {
                cur_adj[i]
                    .iter()
                    .filter(|&&(j, _)| j == i)
                    .map(|&(_, w)| w)
                    .sum()
            })
            .collect();

        let mut improved_any = false;
        let mut moved = true;
        let mut guard = 0;
        while moved && guard < 50 {
            moved = false;
            guard += 1;
            for v in 0..level_n {
                let cv = comm[v];
                // Weights from v into each neighbouring community.
                // BTreeMap (not HashMap): the gain loop below iterates
                // this, and HashMap's per-process-random order would
                // break near-ties differently every run — making Louvain
                // non-deterministic on larger graphs (community colours
                // changing on every reload). Ordered by community id, the
                // tie-break is stable.
                let mut w_to: BTreeMap<usize, f64> = BTreeMap::new();
                for &(u, w) in &cur_adj[v] {
                    if u == v {
                        continue;
                    }
                    *w_to.entry(comm[u]).or_insert(0.0) += w;
                }
                // Remove v from its community.
                sigma_tot[cv] -= k[v];
                let ki = k[v];
                let mut best_c = cv;
                let mut best_gain = resolution * sigma_tot[cv] / m2 * ki
                    - w_to.get(&cv).copied().unwrap_or(0.0);
                // gain(target) = w_to[c] - γ·Σtot[c]·ki/m2 ; pick max.
                let mut best_delta = w_to.get(&cv).copied().unwrap_or(0.0)
                    - resolution * sigma_tot[cv] / m2 * ki;
                for (&c, &wc) in &w_to {
                    let delta = wc - resolution * sigma_tot[c] / m2 * ki;
                    if delta > best_delta + 1e-12 {
                        best_delta = delta;
                        best_c = c;
                        best_gain = delta;
                    }
                }
                let _ = best_gain;
                sigma_tot[best_c] += ki;
                if best_c != cv {
                    comm[v] = best_c;
                    moved = true;
                    improved_any = true;
                }
            }
        }
        let _ = self_loop;

        // Renumber communities 0..c and fold into node2comm.
        let mut remap: HashMap<usize, usize> = HashMap::new();
        for c in comm.iter_mut() {
            let next = remap.len();
            *c = *remap.entry(*c).or_insert(next);
        }
        let new_n = remap.len();
        for original in node2comm.iter_mut() {
            *original = comm[*original];
        }

        if !improved_any || new_n == level_n {
            break;
        }

        // Aggregate: build the community graph for the next level.
        // BTreeMap so `into_iter()` below yields neighbours in a stable
        // order — otherwise the next level's (non-associative) float sums
        // shift run-to-run and reintroduce the non-determinism.
        let mut agg: Vec<BTreeMap<usize, f64>> = vec![BTreeMap::new(); new_n];
        for vtx in 0..level_n {
            let cv = comm[vtx];
            for &(u, w) in &cur_adj[vtx] {
                *agg[cv].entry(comm[u]).or_insert(0.0) += w;
            }
        }
        cur_adj = agg
            .into_iter()
            .map(|m| m.into_iter().collect::<Vec<_>>())
            .collect();
        cur_n = new_n;
    }

    node2comm.iter().map(|&c| c as i32).collect()
}

// ---------------------------------------------------------------------------
// Cycle enumeration: faithful port of cycle.ts findAllCycles +
// bundleRawCycles (Tarjan SCC + iterative Johnson's, contraction, and
// the visual-key dedup). `node_remap`/`hidden` mirror the JS optionals.
// ---------------------------------------------------------------------------

/// CSR over visible+remapped edges (port of cycle.ts `buildCsr`).
fn build_csr_cycles(
    n: usize,
    edges_flat: &[i32],
    edge_type_ids: &[i32],
    node_remap: Option<&[i32]>,
    hidden: Option<&[bool]>,
) -> (Vec<i32>, Vec<i32>) {
    let e = edges_flat.len() / 2;
    let mut out_idx = vec![0i32; n + 1];
    let mut ra = vec![0i32; e];
    let mut rb = vec![0i32; e];
    let mut m = 0usize;
    // When `node_remap` is supplied many original edges collapse onto
    // the same `(a, b)` contracted pair (every file of package A that
    // points at package B contributes another a→b edge). Leaving those
    // duplicates in the CSR makes Johnson's enumerate the same
    // elementary cycle once per parallel-edge combination — on
    // do-not-commit.json this exploded a 4-cycle truth into ~1000
    // emitted dupes that swamped the info-panel cycle list. Dedupe at
    // insert time so each contracted pair appears at most once. Skip
    // the per-node `HashSet` when `node_remap` is None — raw graphs are
    // already deduped by the parser and the allocation isn't free.
    let mut seen_targets: Vec<std::collections::HashSet<i32>> = if node_remap.is_some() {
        (0..n).map(|_| std::collections::HashSet::new()).collect()
    } else {
        Vec::new()
    };
    for i in 0..e {
        if let Some(h) = hidden {
            let t = edge_type_ids.get(i).copied().unwrap_or(0) as usize;
            if h.get(t).copied().unwrap_or(false) {
                continue;
            }
        }
        let mut a = edges_flat[2 * i];
        let mut b = edges_flat[2 * i + 1];
        if let Some(rm) = node_remap {
            a = rm[a as usize];
            b = rm[b as usize];
            if a < 0 || b < 0 || a == b {
                continue;
            }
            if !seen_targets[a as usize].insert(b) {
                continue;
            }
        }
        ra[m] = a;
        rb[m] = b;
        m += 1;
        out_idx[a as usize + 1] += 1;
    }
    for i in 0..n {
        out_idx[i + 1] += out_idx[i];
    }
    let mut out_adj = vec![0i32; m];
    let mut filled = vec![0i32; n];
    for i in 0..m {
        let a = ra[i] as usize;
        out_adj[(out_idx[a] + filled[a]) as usize] = rb[i];
        filled[a] += 1;
    }
    (out_idx, out_adj)
}

/// Iterative Tarjan SCC (port of cycle.ts `tarjanScc`).
fn tarjan_scc(
    n: usize,
    out_idx: &[i32],
    out_adj: &[i32],
    exclude_node: i32,
    node_remap: Option<&[i32]>,
) -> Vec<Vec<i32>> {
    let mut index_of = vec![-1i32; n];
    let mut lowlink = vec![0i32; n];
    let mut on_stack = vec![false; n];
    let mut stack: Vec<i32> = Vec::new();
    let mut call_node = vec![0i32; n];
    let mut call_cursor = vec![0i32; n];
    let mut idx_counter = 0i32;
    let mut sccs: Vec<Vec<i32>> = Vec::new();
    let remapped_self = |w: i32| node_remap.map(|r| r[w as usize] != w).unwrap_or(false);

    for start in 0..n as i32 {
        if index_of[start as usize] != -1 || start < exclude_node || remapped_self(start) {
            continue;
        }
        let mut depth = 0usize;
        call_node[0] = start;
        call_cursor[0] = out_idx[start as usize];
        depth = depth + 1;
        index_of[start as usize] = idx_counter;
        lowlink[start as usize] = idx_counter;
        idx_counter += 1;
        stack.push(start);
        on_stack[start as usize] = true;

        while depth > 0 {
            let v = call_node[depth - 1];
            let end = out_idx[v as usize + 1];
            let mut recursed = false;
            while call_cursor[depth - 1] < end {
                let j = call_cursor[depth - 1];
                let w = out_adj[j as usize];
                call_cursor[depth - 1] = j + 1;
                if w < exclude_node || remapped_self(w) {
                    continue;
                }
                if index_of[w as usize] == -1 {
                    call_node[depth] = w;
                    call_cursor[depth] = out_idx[w as usize];
                    depth += 1;
                    index_of[w as usize] = idx_counter;
                    lowlink[w as usize] = idx_counter;
                    idx_counter += 1;
                    stack.push(w);
                    on_stack[w as usize] = true;
                    recursed = true;
                    break;
                } else if on_stack[w as usize] && index_of[w as usize] < lowlink[v as usize] {
                    lowlink[v as usize] = index_of[w as usize];
                }
            }
            if recursed {
                continue;
            }
            if lowlink[v as usize] == index_of[v as usize] {
                let mut scc: Vec<i32> = Vec::new();
                loop {
                    let popped = stack.pop().unwrap();
                    on_stack[popped as usize] = false;
                    scc.push(popped);
                    if popped == v {
                        break;
                    }
                }
                if scc.len() > 1 {
                    sccs.push(scc);
                }
            }
            depth -= 1;
            if depth > 0 {
                let parent = call_node[depth - 1];
                if lowlink[v as usize] < lowlink[parent as usize] {
                    lowlink[parent as usize] = lowlink[v as usize];
                }
            }
        }
    }
    sccs
}

/// Iterative Johnson's over one SCC (port of
/// `enumerateElementaryCyclesInScc`), B stored as a linked list.
///
/// `seen_keys` deduplicates by *visual key* — the same one the panels
/// would apply client-side. `visualCycleKey` collapses cycles that
/// share head/second/last/length (>5 nodes) or the full canonical
/// sequence (≤5 nodes), so dense SCCs don't flood the output with
/// near-duplicates that all render to the same panel row.
///
/// Enumeration runs to completion: Johnson's is exponential in the
/// worst case, and on pathological inputs this can take a long time.
/// That's the user-visible trade-off of unbounded cycle detection —
/// the previous emission/unique caps traded completeness for a hard
/// upper bound on work.
///
/// `progress`, when provided, is called every `PROGRESS_EVERY` raw
/// emissions with `(unique_cycles_so_far)` so the panel can show a
/// live count while the enumeration runs.
#[allow(clippy::too_many_arguments)]
fn enumerate_cycles_in_scc(
    scc: &[i32],
    n: usize,
    out_idx: &[i32],
    out_adj: &[i32],
    in_scc: &[bool],
    out: &mut Vec<Vec<i32>>,
    seen_keys: &mut std::collections::HashSet<String>,
    progress: Option<&dyn Fn(u32)>,
    raw_emitted: &mut u64,
) {
    let mut blocked = vec![false; n];
    let mut b_head = vec![-1i32; n];
    let mut b_node: Vec<i32> = Vec::new();
    let mut b_next: Vec<i32> = Vec::new();
    let mut path: Vec<i32> = Vec::new();
    let mut cursor: Vec<i32> = Vec::new();
    let mut found_at_depth = vec![false; scc.len()];
    let mut unblock_stack: Vec<i32> = Vec::new();

    for &start in scc {
        for &v in scc {
            blocked[v as usize] = false;
            b_head[v as usize] = -1;
        }
        b_node.clear();
        b_next.clear();
        path.clear();
        cursor.clear();
        path.push(start);
        cursor.push(out_idx[start as usize]);
        found_at_depth[0] = false;
        blocked[start as usize] = true;

        while !path.is_empty() {
            let depth = path.len() - 1;
            let v = path[depth];
            let end = out_idx[v as usize + 1];
            let mut recursed = false;

            while cursor[depth] < end {
                let j = cursor[depth];
                let w = out_adj[j as usize];
                cursor[depth] = j + 1;
                if !in_scc[w as usize] || w < start {
                    continue;
                }
                if w == start {
                    let key = visual_cycle_key(&path);
                    if seen_keys.insert(key) {
                        out.push(path.clone());
                    }
                    found_at_depth[depth] = true;
                    *raw_emitted += 1;
                    // Throttle the cross-WASM/JS call: every PROGRESS_EVERY
                    // raw emissions, post the current unique-cycle count. The
                    // worker receives it via a Comlink.proxy callback, which
                    // delivers a postMessage to the main thread; doing it on
                    // every emission would dominate runtime on dense SCCs.
                    if *raw_emitted % PROGRESS_EVERY == 0 {
                        if let Some(f) = progress {
                            f(seen_keys.len() as u32);
                        }
                    }
                    continue;
                }
                if !blocked[w as usize] {
                    path.push(w);
                    cursor.push(out_idx[w as usize]);
                    found_at_depth[path.len() - 1] = false;
                    blocked[w as usize] = true;
                    recursed = true;
                    break;
                }
            }
            if recursed {
                continue;
            }

            let v_found = found_at_depth[depth];
            if v_found {
                // unblock(v), iterative
                if b_head[v as usize] == -1 {
                    blocked[v as usize] = false;
                } else {
                    unblock_stack.clear();
                    unblock_stack.push(v);
                    while let Some(node) = unblock_stack.pop() {
                        if !blocked[node as usize] {
                            continue;
                        }
                        blocked[node as usize] = false;
                        let mut entry = b_head[node as usize];
                        b_head[node as usize] = -1;
                        while entry != -1 {
                            let w = b_node[entry as usize];
                            let next = b_next[entry as usize];
                            if blocked[w as usize] {
                                unblock_stack.push(w);
                            }
                            entry = next;
                        }
                    }
                }
            } else {
                let mut j = out_idx[v as usize];
                while j < end {
                    let w = out_adj[j as usize];
                    j += 1;
                    if !in_scc[w as usize] || w < start || w == v {
                        continue;
                    }
                    b_node.push(v);
                    b_next.push(b_head[w as usize]);
                    b_head[w as usize] = (b_node.len() - 1) as i32;
                }
            }

            path.pop();
            cursor.pop();
            if v_found && !path.is_empty() {
                let d = path.len() - 1;
                found_at_depth[d] = true;
            }
        }
    }
}

/// How often (in raw Johnson's emissions) to fire the progress callback
/// during cycle enumeration. Power of two so the modulo lowers to a
/// mask; large enough that the per-SCC progress chatter is dominated by
/// the actual enumeration work, small enough that the panel sees a tick
/// every few ms on dense SCCs.
const PROGRESS_EVERY: u64 = 1 << 12;

/// Port of cycle.ts `findAllCycles`.
///
/// Enumerates every elementary directed cycle, deduplicated by
/// `visual_cycle_key` (the same key the JS panels apply downstream).
/// No emission cap — Johnson's runs to completion. On pathological
/// SCCs this is exponential in the worst case; callers that drive the
/// resident session should keep that in mind when invoking
/// cycle-detection on user-supplied graphs.
///
/// `progress`, when provided, fires every `PROGRESS_EVERY` raw
/// emissions with the running unique-cycle count so the cycles panel
/// can render a live count while the worker is busy.
pub fn find_all_cycles(
    n: usize,
    edges_flat: &[i32],
    edge_type_ids: &[i32],
    node_remap: Option<&[i32]>,
    hidden: Option<&[bool]>,
    progress: Option<&dyn Fn(u32)>,
) -> Vec<Vec<i32>> {
    if n == 0 {
        return Vec::new();
    }
    let (out_idx, out_adj) = build_csr_cycles(n, edges_flat, edge_type_ids, node_remap, hidden);
    let sccs = tarjan_scc(n, &out_idx, &out_adj, 0, node_remap);
    let mut cycles: Vec<Vec<i32>> = Vec::new();
    let mut seen_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut raw_emitted: u64 = 0;
    for mut scc in sccs {
        if scc.len() < 2 {
            continue;
        }
        scc.sort_unstable();
        let mut in_scc = vec![false; n];
        for &v in &scc {
            in_scc[v as usize] = true;
        }
        enumerate_cycles_in_scc(
            &scc,
            n,
            &out_idx,
            &out_adj,
            &in_scc,
            &mut cycles,
            &mut seen_keys,
            progress,
            &mut raw_emitted,
        );
    }
    cycles.sort_by_key(|c| c.len());
    cycles
}

/// Port of cycle.ts `contractCycle`.
fn contract_cycle(raw: &[i32], node_remap: Option<&[i32]>) -> Option<Vec<i32>> {
    let Some(rm) = node_remap else {
        return Some(raw.to_vec());
    };
    let mut out: Vec<i32> = Vec::new();
    for &idx in raw {
        let r = rm[idx as usize];
        if r < 0 {
            return None;
        }
        if out.last() == Some(&r) {
            continue;
        }
        out.push(r);
    }
    while out.len() > 1 && out[0] == out[out.len() - 1] {
        out.pop();
    }
    if out.len() >= 2 {
        Some(out)
    } else {
        None
    }
}

/// Port of cycle.ts `visualCycleKey`.
fn visual_cycle_key(cycle: &[i32]) -> String {
    let n = cycle.len();
    if n == 0 {
        return String::new();
    }
    let mut min_idx = 0;
    for i in 1..n {
        if cycle[i] < cycle[min_idx] {
            min_idx = i;
        }
    }
    if n <= 5 {
        let mut s = String::new();
        for i in 0..n {
            if i > 0 {
                s.push(',');
            }
            s.push_str(&cycle[(min_idx + i) % n].to_string());
        }
        return s;
    }
    let first = cycle[min_idx];
    let second = cycle[(min_idx + 1) % n];
    let last = cycle[(min_idx + n - 1) % n];
    format!("{first}|{second}|{last}|{n}")
}

/// Port of cycle.ts `findBundledCyclesViaRaw` (find_all + dedup-bundle).
pub fn find_bundled_cycles_via_raw(
    n: usize,
    edges_flat: &[i32],
    edge_type_ids: &[i32],
    node_remap: Option<&[i32]>,
    hidden: Option<&[bool]>,
) -> Vec<Vec<i32>> {
    let raw = find_all_cycles(n, edges_flat, edge_type_ids, node_remap, hidden, None);
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<Vec<i32>> = Vec::new();
    for r in &raw {
        if let Some(bundled) = contract_cycle(r, node_remap) {
            let key = visual_cycle_key(&bundled);
            if seen.insert(key) {
                out.push(bundled);
            }
        }
    }
    out.sort_by_key(|c| c.len());
    out
}
