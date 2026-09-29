(function (MM) {
  'use strict';

  const edgeKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

  function addAdjacent(adj, a, b) {
    if (!adj.has(a)) adj.set(a, []);
    const list = adj.get(a);
    if (!list.includes(b)) list.push(b);
  }

  // Splits a line's (undirected) track graph into drawable chains. Chains break at
  // termini and branch points; pure loops become closed chains.
  function extractChains(line) {
    const used = new Set();
    const chains = [];
    const degree = (id) => line.adj.get(id).length;

    const walk = (start, next) => {
      const path = [start, next];
      used.add(edgeKey(start, next));
      let prev = start;
      let cur = next;
      while (degree(cur) === 2) {
        const nb = line.adj.get(cur).find((n) => n !== prev);
        const key = edgeKey(cur, nb);
        if (used.has(key)) break;
        used.add(key);
        path.push(nb);
        prev = cur;
        cur = nb;
      }
      return path;
    };

    for (const [id, nbs] of line.adj) {
      if (nbs.length === 2) continue;
      for (const n of nbs) {
        if (!used.has(edgeKey(id, n))) chains.push({ stations: walk(id, n), closed: false });
      }
    }
    for (const [id, nbs] of line.adj) {
      for (const n of nbs) {
        if (used.has(edgeKey(id, n))) continue;
        const stations = walk(id, n);
        chains.push({ stations, closed: stations[0] === stations[stations.length - 1] });
      }
    }
    return chains;
  }

  const validColor = (c) => typeof c === 'string' && (!window.CSS || CSS.supports('color', c));

  function buildGraph(data) {
    if (!data || !Array.isArray(data.stations) || !Array.isArray(data.lines)) {
      throw new Error('JSON must contain "stations" and "lines" arrays.');
    }

    const stations = new Map();
    for (const s of data.stations) {
      if (!s || s.id == null || !s.position) continue;
      const x = Number(s.position.x);
      const y = Number(s.position.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const label = String(s.label ?? s.id);
      stations.set(s.id, {
        id: s.id,
        label,
        labels: Array.isArray(s.labels) && s.labels.length ? s.labels.map(String) : [label],
        // Source data is y-up; the screen is y-down.
        geo: { x, y: -y },
        edges: [],
      });
    }

    const edges = new Map();
    const lines = [];
    data.lines.forEach((l, i) => {
      if (!l) return;
      const line = {
        id: l.id ?? `line-${i}`,
        name: l.name || `Line ${i + 1}`,
        color: validColor(l.color) ? l.color : '#888888',
        index: lines.length,
        adj: new Map(),
        chains: [],
      };
      const seen = new Set();
      for (const e of l.edges || []) {
        if (!e || e.source === e.target) continue;
        if (!stations.has(e.source) || !stations.has(e.target)) continue;
        const key = edgeKey(e.source, e.target);
        if (seen.has(key)) continue;
        seen.add(key);
        addAdjacent(line.adj, e.source, e.target);
        addAdjacent(line.adj, e.target, e.source);
        let edge = edges.get(key);
        if (!edge) {
          const [a, b] = e.source < e.target ? [e.source, e.target] : [e.target, e.source];
          edge = { key, a, b, lines: [], geoLength: 0 };
          edges.set(key, edge);
        }
        edge.lines.push(line);
      }
      if (!seen.size) return;
      line.chains = extractChains(line);
      lines.push(line);
    });

    for (const edge of edges.values()) {
      const sa = stations.get(edge.a);
      const sb = stations.get(edge.b);
      sa.edges.push(edge);
      sb.edges.push(edge);
      edge.geoLength = Math.hypot(sa.geo.x - sb.geo.x, sa.geo.y - sb.geo.y);
    }
    for (const [id, s] of stations) if (!s.edges.length) stations.delete(id);

    const lengths = [...edges.values()].map((e) => e.geoLength).sort((a, b) => a - b);
    const medianEdgeLength = lengths.length ? lengths[lengths.length >> 1] || 1 : 1;

    // Separate stations that sit almost on top of each other (e.g. "Ueno" and
    // "Ueno Halt") are treated as an out-of-station transfer.
    const transfers = [];
    const list = [...stations.values()];
    const threshold = medianEdgeLength * 0.12;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (Math.hypot(a.geo.x - b.geo.x, a.geo.y - b.geo.y) > threshold) continue;
        const key = edgeKey(a.id, b.id);
        if (edges.has(key)) continue;
        transfers.push({ key: `t:${key}`, a: a.id, b: b.id });
      }
    }

    return { stations, edges, lines, transfers, medianEdgeLength };
  }

  // Returns a copy of `data` where each group of nearby stations (the pairs that
  // buildGraph would link with a transfer) becomes one station carrying all names.
  function mergeNearby(data) {
    const graph = buildGraph(data);
    if (!graph.transfers.length) return data;
    const parent = new Map();
    const find = (x) => {
      while (parent.has(x)) x = parent.get(x);
      return x;
    };
    for (const t of graph.transfers) {
      const ra = find(t.a);
      const rb = find(t.b);
      if (ra !== rb) parent.set(rb, ra);
    }

    const groups = new Map();
    for (const s of data.stations) {
      if (!s || s.id == null || !s.position) continue;
      const root = find(s.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(s);
    }
    const stations = [...groups].map(([root, members]) => {
      const labels = members.map((m) => String(m.label ?? m.id));
      return {
        id: root,
        label: labels.join(' / '),
        labels,
        position: {
          x: members.reduce((a, m) => a + Number(m.position.x), 0) / members.length,
          y: members.reduce((a, m) => a + Number(m.position.y), 0) / members.length,
        },
      };
    });
    const lines = data.lines.map((l) => l && {
      ...l,
      edges: (l.edges || []).map((e) => e && { ...e, source: find(e.source), target: find(e.target) }),
    });
    return { stations, lines };
  }

  MM.edgeKey = edgeKey;
  MM.buildGraph = buildGraph;
  MM.mergeNearby = mergeNearby;
})((window.MetroMap = window.MetroMap || {}));
