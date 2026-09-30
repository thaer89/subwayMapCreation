(function (MM) {
  'use strict';

  // Decides where each line runs in pixel space: the polyline of every edge, the
  // sideways offset of each line within an edge's bundle, and the resulting
  // offset path of each line chain.

  const { sub, dot, cross, unitVec, leftNormal } = MM.geometry;

  const edgeBetween = (graph, s, t) => graph.edges.get(MM.edgeKey(s, t));

  // Candidate with the lowest cost; ties keep `current`, then the earliest candidate.
  function cheapest(candidates, cost, current) {
    let best = current;
    let bestCost = current === undefined ? Infinity : cost(current);
    for (const c of candidates) {
      const v = cost(c);
      if (v < bestCost - 1e-9) {
        bestCost = v;
        best = c;
      }
    }
    return best;
  }

  // Pixel polyline of every edge (canonical a→b direction), following the grid
  // routing of schematic layouts.
  function edgePolylines(graph, layout, unit) {
    const polys = new Map();
    for (const e of graph.edges.values()) {
      const a = layout.pos.get(e.a);
      const b = layout.pos.get(e.b);
      const flat = layout.schematic
        ? MM.gridPolyline(a.x, a.y, b.x, b.y, layout.flip.get(e.key))
        : [a.x, a.y, b.x, b.y];
      const pts = [];
      for (let i = 0; i < flat.length; i += 2) pts.push({ x: flat[i] * unit, y: flat[i + 1] * unit });
      polys.set(e.key, pts);
    }
    return polys;
  }

  // ---- Line order on shared track -------------------------------------------
  // Follow two lines from a shared edge until they part; the one that turns
  // further left must sit on the left, so they separate without crossing.
  // Returns edge key -> Map(line id -> offset along the edge's a→b left normal),
  // with each bundle centred on its edge.
  function orderLines(graph, edgeLines, polys, spacing) {
    // Direction of the first drawn segment when leaving station s towards t.
    const dirFrom = (s, t) => {
      const e = edgeBetween(graph, s, t);
      const p = polys.get(e.key);
      return s === e.a ? unitVec(p[0], p[1]) : unitVec(p[p.length - 1], p[p.length - 2]);
    };
    const nextOn = (line, prev, cur) => {
      const nb = line.adj.get(cur);
      if (!nb || nb.length !== 2) return null;
      return nb[0] === prev ? nb[1] : nb[1] === prev ? nb[0] : null;
    };
    const leftness = (din, dout) => -Math.atan2(cross(din, dout), dot(din, dout));

    // Walks A and B together from `from`→`to`. `result` is -1 if A must sit left
    // of B (relative to that travel direction), 1 if right, 0 if undecided;
    // `run` lists the shared edges visited, with dir +1 when travelled a→b.
    function walkTogether(A, B, from, to) {
      const run = [];
      const visit = (p, c) => {
        const e = edgeBetween(graph, p, c);
        run.push({ key: e.key, dir: p === e.a ? 1 : -1 });
      };
      let prev = from;
      let cur = to;
      visit(prev, cur);
      for (let step = 0; step < 500; step++) {
        const nA = nextOn(A, prev, cur);
        const nB = nextOn(B, prev, cur);
        if (nA == null || nB == null) return { result: 0, run };
        if (nA !== nB) {
          const back = dirFrom(cur, prev);
          const din = { x: -back.x, y: -back.y };
          const lA = leftness(din, dirFrom(cur, nA));
          const lB = leftness(din, dirFrom(cur, nB));
          if (Math.abs(lA - lB) < 1e-6) return { result: 0, run };
          return { result: lA > lB ? -1 : 1, run };
        }
        prev = cur;
        cur = nA;
        if (prev === from && cur === to) return { result: 0, run };
        visit(prev, cur);
      }
      return { result: 0, run };
    }

    function compareOnEdge(A, B, e) {
      const fwd = walkTogether(A, B, e.a, e.b);
      if (fwd.result) return fwd.result;
      const bwd = walkTogether(A, B, e.b, e.a);
      if (bwd.result) return -bwd.result;
      // Lines that never part (or only end): fix their order once, on the
      // smallest edge key of the shared run, so every edge of the run agrees
      // and the lines do not swap sides at stations.
      let anchor = null;
      for (const r of fwd.run) if (!anchor || r.key < anchor.key) anchor = r;
      for (const r of bwd.run) if (!anchor || r.key < anchor.key) anchor = { key: r.key, dir: -r.dir };
      return Math.sign(A.index - B.index) * anchor.dir;
    }

    const offsets = new Map();
    for (const e of graph.edges.values()) {
      const ls = edgeLines.get(e.key).slice();
      ls.sort((A, B) => compareOnEdge(A, B, e));
      const k = ls.length;
      offsets.set(e.key, new Map(ls.map((l, i) => [l.id, ((k - 1) / 2 - i) * spacing])));
    }
    return offsets;
  }

  // ---- Keep lines on the same track through stations ---------------------------
  // Each edge's bundle is centred by default, so a line jumps sideways wherever
  // the bundle gains or loses a line. Slide whole bundles to positions that line
  // continuing lines up exactly, minimising the number of jumps with a small
  // cost for moving a bundle off centre. Mutates `offsets`.
  function alignBundles(graph, visible, offsets, spacing) {
    // Edge key -> lines continuing through a station onto `other`. Travel offset
    // = travel sign × canonical offset, so a line keeps its track when the
    // canonical offsets relate by `sign` (the product of both travel signs).
    const links = new Map();
    for (const e of graph.edges.values()) links.set(e.key, []);
    for (const line of visible) {
      for (const [sid, adj] of line.adj) {
        if (adj.length !== 2) continue;
        const e1 = edgeBetween(graph, adj[0], sid);
        const e2 = edgeBetween(graph, sid, adj[1]);
        if (!offsets.get(e1.key).has(line.id) || !offsets.get(e2.key).has(line.id)) continue;
        const sign = (adj[0] === e1.a ? 1 : -1) * (sid === e2.a ? 1 : -1);
        links.get(e1.key).push({ line: line.id, other: e2.key, sign });
        links.get(e2.key).push({ line: line.id, other: e1.key, sign });
      }
    }

    const shift = new Map([...links.keys()].map((k) => [k, 0]));
    // Offset on edge `key` that keeps the linked line on its track from `other`.
    const target = ({ line, other, sign }) => sign * (offsets.get(other).get(line) + shift.get(other));
    // With `placed`, only neighbours already placed are considered.
    const linksOf = (key, placed) => links.get(key).filter(({ other }) => !placed || placed.has(other));
    const cost = (key, c, placed) => {
      const own = offsets.get(key);
      let total = (Math.abs(c) / spacing) * 0.35;
      for (const link of linksOf(key, placed)) {
        const d = Math.abs(target(link) - (own.get(link.line) + c));
        if (d > 0.5) total += 1 + (d / spacing) * 0.1;
      }
      return total;
    };
    const bestShift = (key, placed, current) => cheapest(
      [0, ...linksOf(key, placed).map((link) => target(link) - offsets.get(key).get(link.line))],
      (c) => cost(key, c, placed),
      current,
    );

    // Seed: spread outwards from the busiest edges, aligning each edge with the
    // neighbours already placed.
    const placed = new Set();
    const byBundle = [...links.keys()].sort((a, b) => offsets.get(b).size - offsets.get(a).size);
    for (const start of byBundle) {
      if (placed.has(start)) continue;
      placed.add(start);
      const queue = [start];
      while (queue.length) {
        const key = queue.shift();
        for (const { other } of links.get(key)) {
          if (placed.has(other)) continue;
          shift.set(other, bestShift(other, placed));
          placed.add(other);
          queue.push(other);
        }
      }
    }

    // Refine against all neighbours.
    for (let iter = 0; iter < 20; iter++) {
      let changed = false;
      for (const [key, list] of links) {
        if (!list.length) continue;
        const best = bestShift(key, null, shift.get(key));
        if (best !== shift.get(key)) {
          shift.set(key, best);
          changed = true;
        }
      }
      if (!changed) break;
    }

    for (const [key, s] of shift) {
      const own = offsets.get(key);
      for (const [id, o] of own) own.set(id, o + s);
    }
  }

  // ---- Shared corridors --------------------------------------------------------
  // Segments of different edges that lie on the same stretch of track are
  // shifted apart so their bundles run side by side instead of on top of each
  // other. Returns shifts keyed `${edgeKey}:${segmentIndex}`, along the
  // canonical (a→b) left normal.
  function corridorShifts(graph, edgeLines, polys, spacing) {
    const segs = [];
    for (const e of graph.edges.values()) {
      const k = edgeLines.get(e.key).length;
      if (!k) continue;
      const p = polys.get(e.key);
      for (let j = 0; j < p.length - 1; j++) {
        if (Math.hypot(p[j + 1].x - p[j].x, p[j + 1].y - p[j].y) < 1e-6) continue;
        segs.push({ e, j, a: p[j], b: p[j + 1], d: unitVec(p[j], p[j + 1]), width: k * spacing });
      }
    }
    const sharesTrack = (s, t) => {
      if (Math.abs(cross(s.d, t.d)) > 1e-6 || Math.abs(cross(s.d, sub(t.a, s.a))) > 0.5) return false;
      const len = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
      const t0 = dot(sub(t.a, s.a), s.d);
      const t1 = dot(sub(t.b, s.a), s.d);
      return Math.min(len, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)) > 1;
    };

    // Union-find over segments sharing track.
    const parent = segs.map((_, i) => i);
    const find = (i) => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        if (segs[i].e !== segs[j].e && sharesTrack(segs[i], segs[j])) parent[find(j)] = find(i);
      }
    }
    const groups = new Map();
    segs.forEach((s, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(s);
    });

    const shifts = new Map();
    for (const group of groups.values()) {
      const ref = group[0];
      const refN = leftNormal(ref.d);
      const byEdge = new Map();
      for (const s of group) {
        if (!byEdge.has(s.e)) byEdge.set(s.e, { e: s.e, segs: [], width: s.width });
        byEdge.get(s.e).segs.push(s);
      }
      if (byEdge.size < 2) continue;
      // Edges that swing further to the left of the shared stretch take the left slot.
      const items = [...byEdge.values()];
      for (const it of items) {
        it.side = polys.get(it.e.key).reduce((acc, p) => acc + dot(sub(p, ref.a), refN), 0);
      }
      items.sort((x, y) => y.side - x.side);
      const total = items.reduce((acc, it) => acc + it.width, 0);
      let acc = 0;
      for (const it of items) {
        const center = total / 2 - acc - it.width / 2;
        acc += it.width;
        for (const s of it.segs) shifts.set(`${s.e.key}:${s.j}`, dot(s.d, ref.d) > 0 ? center : -center);
      }
    }
    return shifts;
  }

  // ---- Offset path of a line chain ---------------------------------------------
  // Joins the offset segments of consecutive edges. Points carry `o` (the line's
  // offset, used to keep corner arcs concentric) and `stop` (the corner is at a
  // station). `corners` lists, per station, the join points placed near it.
  function chainPath(graph, tracks, line, chain) {
    const { polys, offsets, shiftOf } = tracks;
    const st = chain.stations;
    const segs = [];
    for (let i = 0; i < st.length - 1; i++) {
      const e = edgeBetween(graph, st[i], st[i + 1]);
      const reversed = st[i] !== e.a;
      const pts = reversed ? polys.get(e.key).slice().reverse() : polys.get(e.key);
      const lineOffset = offsets.get(e.key).get(line.id);
      for (let j = 0; j < pts.length - 1; j++) {
        const p1 = pts[j];
        const p2 = pts[j + 1];
        const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        if (len < 1e-6) continue;
        const canonical = reversed ? pts.length - 2 - j : j;
        const o = (lineOffset + shiftOf(e, canonical)) * (reversed ? -1 : 1);
        const d = unitVec(p1, p2);
        const n = leftNormal(d);
        const endsAtStation = j === pts.length - 2;
        segs.push({
          a: { x: p1.x + n.x * o, y: p1.y + n.y * o },
          b: { x: p2.x + n.x * o, y: p2.y + n.y * o },
          d, o, len,
          stop: endsAtStation,
          at: endsAtStation ? st[i + 1] : null,
        });
      }
    }
    if (!segs.length) return null;

    const join = (s1, s2) => {
      const cr = cross(s1.d, s2.d);
      if (Math.abs(cr) < 1e-6) {
        if (dot(s1.d, s2.d) < 0) return [{ ...s1.b, o: s1.o }, { ...s2.a, o: s2.o }];
        const shift = Math.hypot(s2.a.x - s1.b.x, s2.a.y - s1.b.y);
        if (shift < 0.5) return [{ ...s2.a, o: s2.o }];
        // Line changes track position: short 45° jog centred on the station.
        const j = Math.min(shift / 2, s1.len * 0.3, s2.len * 0.3);
        return [
          { x: s1.b.x - s1.d.x * j, y: s1.b.y - s1.d.y * j, o: s1.o },
          { x: s2.a.x + s2.d.x * j, y: s2.a.y + s2.d.y * j, o: s2.o },
        ];
      }
      const t = ((s2.a.x - s1.a.x) * s2.d.y - (s2.a.y - s1.a.y) * s2.d.x) / cr;
      return [{ x: s1.a.x + s1.d.x * t, y: s1.a.y + s1.d.y * t, o: (s1.o + s2.o) / 2, stop: s1.stop }];
    };

    const corners = [];
    const joinAt = (s1, s2) => {
      const J = join(s1, s2);
      if (s1.at != null) corners.push({ station: s1.at, points: J });
      return J;
    };
    const inner = [];
    for (let i = 1; i < segs.length; i++) inner.push(...joinAt(segs[i - 1], segs[i]));
    const first = segs[0];
    const last = segs[segs.length - 1];
    if (chain.closed && segs.length > 2) {
      const J = joinAt(last, first);
      return { pts: [J[J.length - 1], ...inner, ...J.slice(0, -1)], closed: true, corners };
    }
    return { pts: [{ ...first.a, o: first.o }, ...inner, { ...last.b, o: last.o }], closed: false, corners };
  }

  // `visible` lines are laid out in bundles `spacing` px apart on a grid of
  // `unit` px. `edgeLines` maps edge key -> visible lines on it.
  function planTracks(graph, layout, visible, { unit, spacing }) {
    const visibleSet = new Set(visible);
    const edgeLines = new Map();
    for (const e of graph.edges.values()) edgeLines.set(e.key, e.lines.filter((l) => visibleSet.has(l)));

    const polys = edgePolylines(graph, layout, unit);
    const offsets = orderLines(graph, edgeLines, polys, spacing);
    alignBundles(graph, visible, offsets, spacing);
    const segmentShifts = corridorShifts(graph, edgeLines, polys, spacing);
    const shiftOf = (e, j) => segmentShifts.get(`${e.key}:${j}`) || 0;

    const tracks = { polys, edgeLines, offsets, shiftOf };
    tracks.chainPath = (line, chain) => chainPath(graph, tracks, line, chain);
    return tracks;
  }

  MM.planTracks = planTracks;
})((window.MetroMap = window.MetroMap || {}));
