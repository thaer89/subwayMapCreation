(function (MM) {
  'use strict';

  // Penalty weights for the schematic optimiser. Positions are integer grid cells.
  const W = {
    nonOctilinear: 30,
    tooShort: 14,
    length: 1.0,
    direction: [0, 0.8, 6, 16, 26], // by number of 45° sectors away from geography
    bend: 2.5,
    crossing: 16,
    transferCrossing: 4,
    overlap: 80,
    nodeOnEdge: 60,
    nodeNearEdge: 4,
    nodeNearNode: 3,
    geo: 0.05,
    transfer: 8,
  };
  // Penalty for a line turning by 0°, 45°, 90°, 135°, 180° at a station.
  const BEND_TABLE = [0, 1, 4, 25, 60];
  const MIN_LENGTH = 2;

  function mulberry32(seed) {
    let a = seed | 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const sectorOf = (dx, dy) => ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
  const sectorDiff = (a, b) => {
    const d = Math.abs(a - b) % 8;
    return d > 4 ? 8 - d : d;
  };
  const isOctilinear = (dx, dy) => dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy);

  function bendPenalty(turn) {
    const x = turn / (Math.PI / 4);
    const i = Math.max(0, Math.min(3, Math.floor(x)));
    return BEND_TABLE[i] + (BEND_TABLE[i + 1] - BEND_TABLE[i]) * (x - i);
  }

  // Flat [x0, y0, x1, y1, ...] route between two grid points. Edges that are not
  // octilinear are drawn as one diagonal and one straight run; `flip` picks the order.
  function gridPolyline(ax, ay, bx, by, flip) {
    const dx = bx - ax;
    const dy = by - ay;
    if (isOctilinear(dx, dy)) return [ax, ay, bx, by];
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    const sx = Math.sign(dx);
    const sy = Math.sign(dy);
    let cx;
    let cy;
    if (!flip) {
      const m = Math.min(adx, ady);
      cx = ax + sx * m;
      cy = ay + sy * m;
    } else if (adx > ady) {
      cx = ax + sx * (adx - ady);
      cy = ay;
    } else {
      cx = ax;
      cy = ay + sy * (ady - adx);
    }
    return [ax, ay, cx, cy, bx, by];
  }

  function orient(ax, ay, bx, by, cx, cy) {
    const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    return v > 1e-9 ? 1 : v < -1e-9 ? -1 : 0;
  }
  function onSegment(ax, ay, bx, by, cx, cy) {
    return (
      Math.min(ax, bx) - 1e-9 <= cx && cx <= Math.max(ax, bx) + 1e-9 &&
      Math.min(ay, by) - 1e-9 <= cy && cy <= Math.max(ay, by) + 1e-9
    );
  }
  function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
    const o1 = orient(ax, ay, bx, by, cx, cy);
    const o2 = orient(ax, ay, bx, by, dx, dy);
    const o3 = orient(cx, cy, dx, dy, ax, ay);
    const o4 = orient(cx, cy, dx, dy, bx, by);
    if (o1 !== o2 && o3 !== o4) return true;
    if (o1 === 0 && onSegment(ax, ay, bx, by, cx, cy)) return true;
    if (o2 === 0 && onSegment(ax, ay, bx, by, dx, dy)) return true;
    if (o3 === 0 && onSegment(cx, cy, dx, dy, ax, ay)) return true;
    if (o4 === 0 && onSegment(cx, cy, dx, dy, bx, by)) return true;
    return false;
  }
  function polylinesIntersect(p, q) {
    for (let i = 0; i + 3 < p.length; i += 2) {
      for (let j = 0; j + 3 < q.length; j += 2) {
        if (segmentsIntersect(p[i], p[i + 1], p[i + 2], p[i + 3], q[j], q[j + 1], q[j + 2], q[j + 3])) return true;
      }
    }
    return false;
  }
  function distanceToPolyline(x, y, p) {
    let best = Infinity;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i];
      const ay = p[i + 1];
      const vx = p[i + 2] - ax;
      const vy = p[i + 3] - ay;
      const len2 = vx * vx + vy * vy;
      const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / len2)) : 0;
      best = Math.min(best, Math.hypot(x - (ax + vx * t), y - (ay + vy * t)));
    }
    return best;
  }
  function bbox(p) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      if (p[i] < x0) x0 = p[i];
      if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1];
      if (p[i + 1] > y1) y1 = p[i + 1];
    }
    return [x0, y0, x1, y1];
  }

  function normalizedGeo(graph, scale) {
    let minX = Infinity;
    let minY = Infinity;
    for (const s of graph.stations.values()) {
      minX = Math.min(minX, s.geo.x);
      minY = Math.min(minY, s.geo.y);
    }
    const out = new Map();
    for (const s of graph.stations.values()) {
      out.set(s.id, { x: (s.geo.x - minX) * scale, y: (s.geo.y - minY) * scale });
    }
    return out;
  }

  function layoutGeographic(graph, opts = {}) {
    const scale = (opts.targetEdge ?? 2.6) / graph.medianEdgeLength;
    return { pos: normalizedGeo(graph, scale), flip: new Map(), schematic: false, stats: null };
  }

  function layoutSchematic(graph, opts = {}) {
    const rand = mulberry32((opts.seed ?? 1) * 9973 + 17);
    const scale = (opts.targetEdge ?? 2.6) / graph.medianEdgeLength;
    const geo = normalizedGeo(graph, scale);
    const nodes = [...graph.stations.values()];
    const N = nodes.length;
    const idx = new Map(nodes.map((s, i) => [s.id, i]));
    const gx = new Float64Array(N);
    const gy = new Float64Array(N);
    nodes.forEach((s, i) => {
      gx[i] = geo.get(s.id).x;
      gy[i] = geo.get(s.id).y;
    });

    const E = [];
    const edgeIndex = new Map();
    for (const edge of graph.edges.values()) {
      const u = idx.get(edge.a);
      const v = idx.get(edge.b);
      edgeIndex.set(edge.key, E.length);
      E.push({
        key: edge.key, u, v, transfer: false, flip: false,
        ideal: Math.max(MIN_LENGTH, edge.geoLength * scale),
        sector: sectorOf(gx[v] - gx[u], gy[v] - gy[u]),
      });
    }
    for (const t of graph.transfers) {
      E.push({ key: t.key, u: idx.get(t.a), v: idx.get(t.b), transfer: true, flip: false, ideal: 1, sector: 0 });
    }
    const inc = Array.from({ length: N }, () => []);
    const nbrs = Array.from({ length: N }, () => new Set());
    E.forEach((e, k) => {
      inc[e.u].push(k);
      inc[e.v].push(k);
      nbrs[e.u].add(e.v);
      nbrs[e.v].add(e.u);
    });

    // Consecutive edge pairs along each line, used to keep lines straight.
    const bends = [];
    const bendsAt = Array.from({ length: N }, () => []);
    const bendSeen = new Map();
    const addBend = (a, b, c) => {
      const key = a < c ? `${a}|${b}|${c}` : `${c}|${b}|${a}`;
      if (bendSeen.has(key)) {
        bendSeen.get(key).weight += 1;
        return;
      }
      const k = bends.length;
      const bend = { b: idx.get(b), e1: edgeIndex.get(MM.edgeKey(a, b)), e2: edgeIndex.get(MM.edgeKey(b, c)), weight: 1 };
      bendSeen.set(key, bend);
      bends.push(bend);
      bendsAt[idx.get(a)].push(k);
      bendsAt[idx.get(b)].push(k);
      bendsAt[idx.get(c)].push(k);
    };
    for (const line of graph.lines) {
      for (const ch of line.chains) {
        const st = ch.stations;
        const n = st.length;
        for (let i = 1; i < n - 1; i++) addBend(st[i - 1], st[i], st[i + 1]);
        if (ch.closed && n > 3) addBend(st[n - 2], st[0], st[1]);
      }
    }

    const X = new Int32Array(N);
    const Y = new Int32Array(N);
    const occupied = new Map();
    const cell = (x, y) => (x + 4096) * 8192 + (y + 4096);

    // Initial placement: snap geography to the grid, busiest stations first.
    const byDegree = [...Array(N).keys()].sort((a, b) => inc[b].length - inc[a].length);
    for (const i of byDegree) {
      const rx = Math.round(gx[i]);
      const ry = Math.round(gy[i]);
      let best = null;
      let bestD = Infinity;
      for (let r = 0; !best; r++) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = rx + dx;
            const y = ry + dy;
            if (occupied.has(cell(x, y))) continue;
            const d = (x - gx[i]) ** 2 + (y - gy[i]) ** 2;
            if (d < bestD) {
              bestD = d;
              best = [x, y];
            }
          }
        }
      }
      X[i] = best[0];
      Y[i] = best[1];
      occupied.set(cell(X[i], Y[i]), i);
    }

    const poly = (k) => {
      const e = E[k];
      return e.transfer
        ? [X[e.u], Y[e.u], X[e.v], Y[e.v]]
        : gridPolyline(X[e.u], Y[e.u], X[e.v], Y[e.v], e.flip);
    };
    // Unit direction of edge k as it leaves node i.
    const dirAt = (k, i) => {
      const p = poly(k);
      let dx;
      let dy;
      if (E[k].u === i) {
        dx = p[2] - p[0];
        dy = p[3] - p[1];
      } else {
        const n = p.length;
        dx = p[n - 4] - p[n - 2];
        dy = p[n - 3] - p[n - 1];
      }
      const L = Math.hypot(dx, dy) || 1;
      return [dx / L, dy / L];
    };

    function edgeCost(k) {
      const e = E[k];
      const dx = X[e.v] - X[e.u];
      const dy = Y[e.v] - Y[e.u];
      const len = Math.max(Math.abs(dx), Math.abs(dy));
      if (e.transfer) return W.transfer * (len - 1) ** 2;
      let c = isOctilinear(dx, dy) ? 0 : W.nonOctilinear;
      c += len < MIN_LENGTH ? W.tooShort * (MIN_LENGTH - len) ** 2 : (W.length * (len - e.ideal) ** 2) / e.ideal;
      c += W.direction[sectorDiff(sectorOf(dx, dy), e.sector)];
      return c;
    }

    function bendCost(bi) {
      const b = bends[bi];
      const d1 = dirAt(b.e1, b.b);
      const d2 = dirAt(b.e2, b.b);
      const dot = Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1]));
      return W.bend * Math.sqrt(b.weight) * bendPenalty(Math.PI - Math.acos(dot));
    }

    function overlapAt(i) {
      const list = inc[i];
      let c = 0;
      for (let a = 0; a < list.length; a++) {
        if (E[list[a]].transfer) continue;
        const d1 = dirAt(list[a], i);
        for (let b = a + 1; b < list.length; b++) {
          if (E[list[b]].transfer) continue;
          const d2 = dirAt(list[b], i);
          if (d1[0] * d2[0] + d1[1] * d2[1] > 0.999) c += W.overlap;
        }
      }
      return c;
    }

    function crossCost(k) {
      const e = E[k];
      const p = poly(k);
      const [x0, y0, x1, y1] = bbox(p);
      let c = 0;
      for (let f = 0; f < E.length; f++) {
        if (f === k) continue;
        const g = E[f];
        if (g.u === e.u || g.u === e.v || g.v === e.u || g.v === e.v) continue;
        const q = poly(f);
        const [qx0, qy0, qx1, qy1] = bbox(q);
        if (qx1 < x0 || qx0 > x1 || qy1 < y0 || qy0 > y1) continue;
        if (polylinesIntersect(p, q)) c += e.transfer || g.transfer ? W.transferCrossing : W.crossing;
      }
      return c;
    }

    const proximity = (d) => (d < 0.01 ? W.nodeOnEdge : d < 0.75 ? W.nodeNearEdge : 0);

    function edgeProximity(k) {
      const e = E[k];
      const p = poly(k);
      let c = 0;
      for (let m = 0; m < N; m++) {
        if (m !== e.u && m !== e.v) c += proximity(distanceToPolyline(X[m], Y[m], p));
      }
      return c;
    }

    function nodeProximity(i) {
      let c = 0;
      for (let f = 0; f < E.length; f++) {
        const g = E[f];
        if (g.u !== i && g.v !== i) c += proximity(distanceToPolyline(X[i], Y[i], poly(f)));
      }
      for (let m = 0; m < N; m++) {
        if (m === i || nbrs[i].has(m)) continue;
        if (Math.max(Math.abs(X[m] - X[i]), Math.abs(Y[m] - Y[i])) === 1) c += W.nodeNearNode;
      }
      return c;
    }

    // Every cost term that changes when node i moves.
    function localCost(i) {
      let c = W.geo * ((X[i] - gx[i]) ** 2 + (Y[i] - gy[i]) ** 2) + nodeProximity(i) + overlapAt(i);
      for (const k of inc[i]) c += edgeCost(k) + crossCost(k) + edgeProximity(k);
      for (const b of bendsAt[i]) c += bendCost(b);
      for (const j of nbrs[i]) c += overlapAt(j);
      return c;
    }

    const order = [...Array(N).keys()];
    const maxIterations = opts.iterations ?? 40;
    for (let iter = 0; iter < maxIterations; iter++) {
      const r = iter < 4 ? 3 : iter < 12 ? 2 : 1;
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      let changed = 0;
      for (const i of order) {
        const ox = X[i];
        const oy = Y[i];
        let best = localCost(i);
        let bx = ox;
        let by = oy;
        occupied.delete(cell(ox, oy));
        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            if (!dx && !dy) continue;
            const x = ox + dx;
            const y = oy + dy;
            if (occupied.has(cell(x, y))) continue;
            X[i] = x;
            Y[i] = y;
            const c = localCost(i);
            if (c < best - 1e-6) {
              best = c;
              bx = x;
              by = y;
            }
          }
        }
        X[i] = bx;
        Y[i] = by;
        occupied.set(cell(bx, by), i);
        if (bx !== ox || by !== oy) changed++;
      }
      for (const e of E) {
        if (e.transfer || isOctilinear(X[e.v] - X[e.u], Y[e.v] - Y[e.u])) continue;
        const before = localCost(e.u) + localCost(e.v);
        e.flip = !e.flip;
        if (localCost(e.u) + localCost(e.v) >= before - 1e-6) e.flip = !e.flip;
        else changed++;
      }
      if (!changed && r === 1) break;
    }

    let minX = Infinity;
    let minY = Infinity;
    for (let i = 0; i < N; i++) {
      minX = Math.min(minX, X[i]);
      minY = Math.min(minY, Y[i]);
    }
    const pos = new Map();
    nodes.forEach((s, i) => pos.set(s.id, { x: X[i] - minX, y: Y[i] - minY }));
    const flip = new Map();
    let nonOctilinear = 0;
    let crossings = 0;
    E.forEach((e, k) => {
      if (e.transfer) return;
      flip.set(e.key, e.flip);
      if (!isOctilinear(X[e.v] - X[e.u], Y[e.v] - Y[e.u])) nonOctilinear++;
      for (let f = k + 1; f < E.length; f++) {
        const g = E[f];
        if (g.transfer || g.u === e.u || g.u === e.v || g.v === e.u || g.v === e.v) continue;
        if (polylinesIntersect(poly(k), poly(f))) crossings++;
      }
    });

    return { pos, flip, schematic: true, stats: { nonOctilinear, crossings } };
  }

  MM.gridPolyline = gridPolyline;
  MM.layoutSchematic = layoutSchematic;
  MM.layoutGeographic = layoutGeographic;
})((window.MetroMap = window.MetroMap || {}));
