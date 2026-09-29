(function (MM) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const FONT_FAMILY = '"Helvetica Neue", Helvetica, Arial, sans-serif';
  const FONT_SIZE = 12;
  const LINE_HEIGHT = FONT_SIZE * 1.15;
  const INTERCHANGE_STROKE = '#1b1b1b';

  function el(tag, attrs, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }
  const fmt = (v) => Math.round(v * 10) / 10;
  const pt = (p) => `${fmt(p.x)} ${fmt(p.y)}`;

  let measureCtx = null;
  function textWidth(text, font) {
    measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  }

  const unitVec = (a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    return { x: dx / L, y: dy / L };
  };
  // Left-hand normal in y-down screen space.
  const leftNormal = (d) => ({ x: d.y, y: -d.x });

  function convexHull(points) {
    const uniq = new Map();
    for (const p of points) uniq.set(`${fmt(p.x)},${fmt(p.y)}`, p);
    const pts = [...uniq.values()].sort((a, b) => a.x - b.x || a.y - b.y);
    if (pts.length < 3) return pts;
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  }

  // Path through `pts` with arcs at corners; each point's `o` (line offset) keeps
  // arcs of parallel lines concentric. Corners flagged `stop` are stations, where
  // the arc may deviate at most `stopDeviation` from the corner so the line still
  // runs through the station marker.
  function roundedPath(pts, closed, radius, stopDeviation) {
    const n = pts.length;
    if (n < 2) return '';
    const corner = (a, b, c) => {
      const l1 = Math.hypot(b.x - a.x, b.y - a.y);
      const l2 = Math.hypot(c.x - b.x, c.y - b.y);
      if (l1 < 1e-6 || l2 < 1e-6) return `L${pt(b)}`;
      const u1 = { x: (b.x - a.x) / l1, y: (b.y - a.y) / l1 };
      const u2 = { x: (c.x - b.x) / l2, y: (c.y - b.y) / l2 };
      const cr = u1.x * u2.y - u1.y * u2.x;
      if (Math.abs(cr) < 1e-4) return `L${pt(b)}`;
      const turn = Math.acos(Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y)));
      const left = cr < 0;
      const base = b.stop ? Math.min(radius, stopDeviation / (1 / Math.cos(turn / 2) - 1)) : radius;
      let r = Math.max(2, base + (left ? -b.o : b.o));
      const tan = Math.tan(turn / 2);
      let t = r * tan;
      const tMax = Math.min(l1, l2) * 0.5;
      if (t > tMax) {
        t = tMax;
        r = t / tan;
      }
      const p1 = { x: b.x - u1.x * t, y: b.y - u1.y * t };
      const p2 = { x: b.x + u2.x * t, y: b.y + u2.y * t };
      return `L${pt(p1)}A${fmt(r)} ${fmt(r)} 0 0 ${left ? 0 : 1} ${pt(p2)}`;
    };
    if (!closed) {
      let d = `M${pt(pts[0])}`;
      for (let i = 1; i < n - 1; i++) d += corner(pts[i - 1], pts[i], pts[i + 1]);
      return `${d}L${pt(pts[n - 1])}`;
    }
    const start = { x: (pts[n - 1].x + pts[0].x) / 2, y: (pts[n - 1].y + pts[0].y) / 2 };
    let d = `M${pt(start)}`;
    for (let i = 0; i < n; i++) d += corner(pts[(i - 1 + n) % n], pts[i], pts[(i + 1) % n]);
    return `${d}Z`;
  }

  // Liang–Barsky: does segment (x1,y1)-(x2,y2) touch rect r?
  function segmentHitsRect(x1, y1, x2, y2, r) {
    let t0 = 0;
    let t1 = 1;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const p = [-dx, dx, -dy, dy];
    const q = [x1 - r.x0, r.x1 - x1, y1 - r.y0, r.y1 - y1];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i] < 0) return false;
      } else {
        const t = q[i] / p[i];
        if (p[i] < 0) t0 = Math.max(t0, t);
        else t1 = Math.min(t1, t);
        if (t0 > t1) return false;
      }
    }
    return true;
  }
  const rectsOverlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

  function splitLabel(text) {
    const variants = [[text]];
    const words = text.split(/\s+/);
    if (words.length < 2) {
      const dash = text.indexOf('-', 3);
      if (dash > 0 && dash < text.length - 3) variants.push([text.slice(0, dash + 1), text.slice(dash + 1)]);
      return variants;
    }
    let best = null;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ');
      const b = words.slice(i).join(' ');
      const score = Math.max(a.length, b.length);
      if (!best || score < best.score) best = { score, lines: [a, b] };
    }
    variants.push(best.lines);
    return variants;
  }

  function render(root, graph, layout, opts) {
    const lineWidth = opts.lineWidth ?? 6;
    const gap = Math.max(1.5, lineWidth * 0.35);
    const spacing = lineWidth + gap;
    const hidden = opts.hidden || new Set();
    const visible = graph.lines.filter((l) => !hidden.has(l.id));
    const visibleSet = new Set(visible);

    let maxBundle = 1;
    const edgeLines = new Map();
    for (const e of graph.edges.values()) {
      maxBundle = Math.max(maxBundle, e.lines.length);
      edgeLines.set(e.key, e.lines.filter((l) => visibleSet.has(l)));
    }
    const unit = Math.max(58, maxBundle * spacing + 36);
    const radius = unit * 0.45;
    const markerR = lineWidth * 0.8 + 1;
    const border = Math.max(1.5, lineWidth * 0.35);
    const pad = markerR + border;

    const P = (id) => {
      const p = layout.pos.get(id);
      return { x: p.x * unit, y: p.y * unit };
    };
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
    const edgeOf = (s, t) => graph.edges.get(MM.edgeKey(s, t));
    // Direction of the first drawn segment when leaving station s towards t.
    const dirFrom = (s, t) => {
      const e = edgeOf(s, t);
      const p = polys.get(e.key);
      return s === e.a ? unitVec(p[0], p[1]) : unitVec(p[p.length - 1], p[p.length - 2]);
    };

    // ---- Line ordering on shared track -------------------------------------
    // Follow two lines from a shared edge until they part; the one that turns
    // further left must sit on the left, so they separate without crossing.
    const nextOn = (line, prev, cur) => {
      const nb = line.adj.get(cur);
      if (!nb || nb.length !== 2) return null;
      return nb[0] === prev ? nb[1] : nb[1] === prev ? nb[0] : null;
    };
    const leftness = (din, dout) =>
      -Math.atan2(din.x * dout.y - din.y * dout.x, din.x * dout.x + din.y * dout.y);
    function side(A, B, from, to) {
      let prev = from;
      let cur = to;
      for (let step = 0; step < 500; step++) {
        const nA = nextOn(A, prev, cur);
        const nB = nextOn(B, prev, cur);
        if (nA == null || nB == null) return 0;
        if (nA !== nB) {
          const back = dirFrom(cur, prev);
          const din = { x: -back.x, y: -back.y };
          const lA = leftness(din, dirFrom(cur, nA));
          const lB = leftness(din, dirFrom(cur, nB));
          if (Math.abs(lA - lB) < 1e-6) return 0;
          return lA > lB ? -1 : 1;
        }
        prev = cur;
        cur = nA;
        if (prev === from && cur === to) return 0;
      }
      return 0;
    }

    const offsets = new Map();
    for (const e of graph.edges.values()) {
      const ls = edgeLines.get(e.key).slice();
      ls.sort((A, B) => side(A, B, e.a, e.b) || -side(A, B, e.b, e.a) || A.index - B.index);
      const k = ls.length;
      offsets.set(e.key, new Map(ls.map((l, i) => [l.id, ((k - 1) / 2 - i) * spacing])));
    }

    // ---- Offset polylines per line ------------------------------------------
    function chainPoints(line, chain) {
      const st = chain.stations;
      const segs = [];
      for (let i = 0; i < st.length - 1; i++) {
        const e = edgeOf(st[i], st[i + 1]);
        let pts = polys.get(e.key);
        let o = offsets.get(e.key).get(line.id);
        if (st[i] !== e.a) {
          pts = pts.slice().reverse();
          o = -o;
        }
        for (let j = 0; j < pts.length - 1; j++) {
          const p1 = pts[j];
          const p2 = pts[j + 1];
          const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
          if (len < 1e-6) continue;
          const d = unitVec(p1, p2);
          const n = leftNormal(d);
          segs.push({
            a: { x: p1.x + n.x * o, y: p1.y + n.y * o },
            b: { x: p2.x + n.x * o, y: p2.y + n.y * o },
            d, o, len,
            stop: j === pts.length - 2,
          });
        }
      }
      if (!segs.length) return null;

      const join = (s1, s2) => {
        const cr = s1.d.x * s2.d.y - s1.d.y * s2.d.x;
        const dot = s1.d.x * s2.d.x + s1.d.y * s2.d.y;
        if (Math.abs(cr) < 1e-6) {
          if (dot < 0) return [{ ...s1.b, o: s1.o }, { ...s2.a, o: s2.o }];
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

      const inner = [];
      for (let i = 1; i < segs.length; i++) inner.push(...join(segs[i - 1], segs[i]));
      const first = segs[0];
      const last = segs[segs.length - 1];
      if (chain.closed && segs.length > 2) {
        const J = join(last, first);
        return { pts: [J[J.length - 1], ...inner, ...J.slice(0, -1)], closed: true };
      }
      return { pts: [{ ...first.a, o: first.o }, ...inner, { ...last.b, o: last.o }], closed: false };
    }

    const gLines = el('g', { class: 'lines' }, root);
    const obstacles = [];
    for (const line of visible) {
      const g = el('g', { class: 'line', 'data-line': line.id }, gLines);
      for (const chain of line.chains) {
        const res = chainPoints(line, chain);
        if (!res) continue;
        const d = roundedPath(res.pts, res.closed, radius, markerR * 0.5);
        el('path', { d, class: 'casing', 'stroke-width': fmt(lineWidth + gap * 1.6) }, g);
        el('path', { d, class: 'stroke', stroke: line.color, 'stroke-width': lineWidth }, g);
        const p = res.pts;
        for (let i = 0; i < p.length - 1; i++) obstacles.push([p[i], p[i + 1]]);
        if (res.closed) obstacles.push([p[p.length - 1], p[0]]);
      }
    }

    // ---- Stations -------------------------------------------------------------
    const info = new Map();
    for (const s of graph.stations.values()) {
      const pts = [];
      const lines = new Set();
      for (const e of s.edges) {
        const off = offsets.get(e.key);
        if (!off.size) continue;
        const p = polys.get(e.key);
        const atA = s.id === e.a;
        const base = atA ? p[0] : p[p.length - 1];
        const n = leftNormal(atA ? unitVec(p[0], p[1]) : unitVec(p[p.length - 2], p[p.length - 1]));
        for (const o of off.values()) pts.push({ x: base.x + n.x * o, y: base.y + n.y * o });
        for (const l of edgeLines.get(e.key)) lines.add(l);
      }
      if (!lines.size) continue;
      const hull = convexHull(pts);
      const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const p of hull) {
        box.x0 = Math.min(box.x0, p.x - pad);
        box.y0 = Math.min(box.y0, p.y - pad);
        box.x1 = Math.max(box.x1, p.x + pad);
        box.y1 = Math.max(box.y1, p.y + pad);
      }
      info.set(s.id, { station: s, center: P(s.id), hull, box, lines: [...lines], transfer: false });
    }
    const transfers = graph.transfers.filter((t) => info.has(t.a) && info.has(t.b));
    for (const t of transfers) {
      info.get(t.a).transfer = true;
      info.get(t.b).transfer = true;
    }

    const gOuter = el('g', { class: 'markers-outer' }, root);
    const gInner = el('g', { class: 'markers-inner' }, root);
    const linkR = markerR * 0.7;
    for (const t of transfers) {
      const d = `M${pt(info.get(t.a).center)}L${pt(info.get(t.b).center)}`;
      const lines = [...new Set([...info.get(t.a).lines, ...info.get(t.b).lines])].map((l) => l.id).join(' ');
      el('path', { d, class: 'transfer', stroke: INTERCHANGE_STROKE, 'stroke-width': fmt(2 * (linkR + border)), 'data-lines': lines }, gOuter);
      el('path', { d, class: 'transfer', stroke: '#fff', 'stroke-width': fmt(2 * linkR), 'data-lines': lines }, gInner);
      obstacles.push([info.get(t.a).center, info.get(t.b).center]);
    }
    for (const [id, s] of info) {
      const h = s.hull;
      const d = h.length === 1
        ? `M${pt(h[0])}h0.01`
        : `M${h.map(pt).join('L')}${h.length > 2 ? 'Z' : ''}`;
      const interchange = s.lines.length > 1 || s.transfer;
      const ring = interchange ? INTERCHANGE_STROKE : s.lines[0].color;
      const common = { d, class: 'marker', 'data-station': id, 'data-lines': s.lines.map((l) => l.id).join(' ') };
      el('path', { ...common, stroke: ring, fill: ring, 'stroke-width': fmt(2 * pad) }, gOuter);
      el('path', { ...common, stroke: '#fff', fill: '#fff', 'stroke-width': fmt(2 * markerR) }, gInner);
    }

    // ---- Labels ---------------------------------------------------------------
    const labelRects = [];
    const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const grow = (r) => {
      bounds.x0 = Math.min(bounds.x0, r.x0);
      bounds.y0 = Math.min(bounds.y0, r.y0);
      bounds.x1 = Math.max(bounds.x1, r.x1);
      bounds.y1 = Math.max(bounds.y1, r.y1);
    };
    for (const s of info.values()) grow(s.box);

    if (opts.showLabels !== false) {
      const gLabels = el('g', { class: 'labels' }, root);
      const markerBoxes = [...info.values()].map((s) => ({ id: s.station.id, box: s.box }));
      const ordered = [...info.values()].sort((a, b) => b.lines.length - a.lines.length || b.station.edges.length - a.station.edges.length);
      const G = 4;
      const candidates = [
        { name: 'E', cost: 0, anchor: 'start' },
        { name: 'W', cost: 0.3, anchor: 'end' },
        { name: 'NE', cost: 0.7, anchor: 'start' },
        { name: 'SE', cost: 0.7, anchor: 'start' },
        { name: 'NW', cost: 0.9, anchor: 'end' },
        { name: 'SW', cost: 0.9, anchor: 'end' },
        { name: 'N', cost: 1.1, anchor: 'middle' },
        { name: 'S', cost: 1.1, anchor: 'middle' },
      ];

      for (const s of ordered) {
        const bold = s.lines.length > 1 || s.transfer;
        const font = `${bold ? 700 : 500} ${FONT_SIZE}px ${FONT_FAMILY}`;
        const b = s.box;
        const cx = (b.x0 + b.x1) / 2;
        const cy = (b.y0 + b.y1) / 2;
        let best = null;
        splitLabel(s.station.label).forEach((lines, variant) => {
          const w = Math.max(...lines.map((t) => textWidth(t, font)));
          const h = lines.length * LINE_HEIGHT;
          for (const c of candidates) {
            let x0;
            let y0;
            switch (c.name) {
              case 'E': x0 = b.x1 + G; y0 = cy - h / 2; break;
              case 'W': x0 = b.x0 - G - w; y0 = cy - h / 2; break;
              case 'N': x0 = cx - w / 2; y0 = b.y0 - G - h; break;
              case 'S': x0 = cx - w / 2; y0 = b.y1 + G; break;
              case 'NE': x0 = b.x1; y0 = b.y0 - h; break;
              case 'SE': x0 = b.x1; y0 = b.y1; break;
              case 'NW': x0 = b.x0 - w; y0 = b.y0 - h; break;
              default: x0 = b.x0 - w; y0 = b.y1; break;
            }
            const rect = { x0, y0, x1: x0 + w, y1: y0 + h };
            const shrunk = { x0: x0 + 1, y0: y0 + 1, x1: rect.x1 - 1, y1: rect.y1 - 1 };
            let cost = c.cost + variant * 0.6;
            for (const [p, q] of obstacles) if (segmentHitsRect(p.x, p.y, q.x, q.y, shrunk)) cost += 10;
            for (const m of markerBoxes) if (m.id !== s.station.id && rectsOverlap(m.box, shrunk)) cost += 20;
            for (const r of labelRects) if (rectsOverlap(r, shrunk)) cost += 40;
            if (!best || cost < best.cost) best = { cost, rect, lines, anchor: c.anchor };
          }
        });

        labelRects.push(best.rect);
        grow(best.rect);
        const { rect, anchor } = best;
        const x = anchor === 'start' ? rect.x0 : anchor === 'end' ? rect.x1 : (rect.x0 + rect.x1) / 2;
        const text = el('text', {
          class: `label${bold ? ' bold' : ''}`,
          'text-anchor': anchor,
          'data-station': s.station.id,
          'data-lines': s.lines.map((l) => l.id).join(' '),
        }, gLabels);
        best.lines.forEach((t, i) => {
          const span = el('tspan', { x: fmt(x), y: fmt(rect.y0 + FONT_SIZE * 0.9 + i * LINE_HEIGHT) }, text);
          span.textContent = t;
        });
      }
    }

    for (const [p, q] of obstacles) {
      grow({ x0: Math.min(p.x, q.x), y0: Math.min(p.y, q.y), x1: Math.max(p.x, q.x), y1: Math.max(p.y, q.y) });
    }
    return { bounds, info };
  }

  MM.render = render;
})((window.MetroMap = window.MetroMap || {}));
