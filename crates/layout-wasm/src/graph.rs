//! Rust port of the JS data pipeline: `schema.ts`/`parser.ts`
//! (`parseGraphJson` → LoadedGraph), `pack.ts` `computeRadii`, and the
//! Louvain community detection currently in `analyze.worker.ts`
//! (graphology). Behavioral match on the structural bits (dedup, drop
//! unknown/self, intern order, degree); Louvain is a standard modularity
//! optimizer — communities only need to be *good*, not byte-identical to
//! graphology.

use std::collections::HashMap;

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
/// folded in as `Err` returns). Drops edges to unknown ids and
/// self-loops; collapses duplicate (from,to) pairs (first edgeType wins).
pub fn parse(json: &str) -> Result<ParsedGraph, String> {
    let root: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("Invalid JSON: {e}"))?;
    let nodes = root
        .get("nodes")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Top-level `nodes` must be an array.".to_string())?;

    let n = nodes.len();
    let mut ids: Vec<String> = Vec::with_capacity(n);
    let mut labels: Vec<String> = Vec::with_capacity(n);
    let mut id_to_index: HashMap<String, i32> = HashMap::with_capacity(n);

    let mut node_type_names: Vec<String> = vec![String::new()];
    let mut node_type_index: HashMap<String, i32> = HashMap::from([(String::new(), 0)]);
    let mut node_type_ids: Vec<i32> = Vec::with_capacity(n);

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

    let mut edge_type_names: Vec<String> = vec![String::new()];
    let mut edge_type_index: HashMap<String, i32> = HashMap::from([(String::new(), 0)]);

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
            let Some(&j) = id_to_index.get(&tid_str) else {
                continue; // unknown id — dropped (JS warns)
            };
            if j == i as i32 {
                continue; // self-loop — dropped
            }
            let key = i as i64 * n as i64 + j as i64;
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

    let mut in_degree = vec![0i32; n];
    let mut out_degree = vec![0i32; n];
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
                let mut w_to: HashMap<usize, f64> = HashMap::new();
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
        let mut agg: Vec<HashMap<usize, f64>> = vec![HashMap::new(); new_n];
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
