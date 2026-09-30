(function (MM) {
  'use strict';

  const { unitVec, leftNormal, cross, dot, distanceToSegment, convexHull, orientedRect, shapeBounds } = MM.geometry;
  const { FONT } = MM;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const INK = '#1b1b1b';

  // Embedded in the live SVG and in PNG exports so both render identically.
  const MAP_CSS = `
.line path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
.line .casing { stroke: #fff; }
.line .hit { stroke: transparent; pointer-events: stroke; cursor: pointer; }
.transfer { fill: none; stroke-linecap: round; }
.marker { cursor: pointer; }
.label { font: 500 ${FONT.size}px ${FONT.family}; fill: ${INK}; paint-order: stroke; stroke: #fff; stroke-width: 3px; stroke-linejoin: round; cursor: pointer; }
.label.bold { font-weight: 700; }
.line, .marker, .transfer, .label { transition: opacity 0.15s; }
svg.dim .line, svg.dim .marker, svg.dim .transfer, svg.dim .label { opacity: 0.08; }
svg.dim .line.active, svg.dim .marker.active, svg.dim .transfer.active, svg.dim .label.active { opacity: 1; }
`;

  function el(tag, attrs, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }
  const fmt = (v) => Math.round(v * 10) / 10;
  const pt = (p) => `${fmt(p.x)} ${fmt(p.y)}`;
  const lineIds = (lines) => lines.map((l) => l.id).join(' ');

  // Pixel sizes derived from the user's line width and gap.
  function computeStyle(graph, opts) {
    const lineWidth = opts.lineWidth ?? 6;
    const gap = Math.max(0, opts.gap ?? lineWidth * 0.35);
    const spacing = lineWidth + gap;
    let maxBundle = 1;
    for (const e of graph.edges.values()) maxBundle = Math.max(maxBundle, e.lines.length);
    const unit = Math.max(58, maxBundle * spacing + 36); // px per grid cell
    const casing = Math.min(gap * 1.6, 6); // extra width of the white outline
    return {
      lineWidth,
      gap,
      spacing,
      unit,
      casing,
      cornerRadius: unit * 0.45,
      markerR: lineWidth * 0.8 + 1,
      border: Math.max(1.5, lineWidth * 0.35),
      // Strokes (with their white casing) closer than this visibly cover each other.
      touch: lineWidth + casing / 4,
    };
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
      const cr = cross(u1, u2);
      if (Math.abs(cr) < 1e-4) return `L${pt(b)}`;
      const turn = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
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

  // Draws every visible line and adds its segments to `obstacles`. Returns
  // station id -> corner points of lines turning there.
  function drawLines(root, visible, tracks, style, obstacles) {
    const stationCorners = new Map();
    const gLines = el('g', { class: 'lines' }, root);
    for (const line of visible) {
      const g = el('g', { class: 'line', 'data-line': line.id }, gLines);
      for (const chain of line.chains) {
        const path = tracks.chainPath(line, chain);
        if (!path) continue;
        for (const { station, points } of path.corners) {
          if (!stationCorners.has(station)) stationCorners.set(station, []);
          stationCorners.get(station).push(...points);
        }
        const d = roundedPath(path.pts, path.closed, style.cornerRadius, style.markerR * 0.5);
        el('path', { d, class: 'casing', 'stroke-width': fmt(style.lineWidth + style.casing) }, g);
        el('path', { d, class: 'stroke', stroke: line.color, 'stroke-width': style.lineWidth }, g);
        el('path', { d, class: 'hit', 'stroke-width': fmt(Math.max(style.lineWidth + 8, 14)) }, g);
        const p = path.pts;
        for (let i = 0; i < p.length - 1; i++) obstacles.push([p[i], p[i + 1]]);
        if (path.closed) obstacles.push([p[p.length - 1], p[0]]);
      }
    }
    return stationCorners;
  }

  // Outline points of a station's marker: where each of its lines meets the
  // station, the corners of lines turning there, and, where lines from different
  // directions converge, far enough along each line to hide the overlap.
  function markerPoints(station, tracks, corners, style) {
    const { polys, offsets, shiftOf } = tracks;
    const pts = [];
    const rays = []; // each line's track leaving the station, up to `reach`
    for (const e of station.edges) {
      const off = offsets.get(e.key);
      if (!off.size) continue;
      const p = polys.get(e.key);
      const atA = station.id === e.a;
      const base = atA ? p[0] : p[p.length - 1];
      const next = atA ? p[1] : p[p.length - 2];
      const out = unitVec(base, next);
      const n = leftNormal(atA ? out : { x: -out.x, y: -out.y });
      const shift = shiftOf(e, atA ? 0 : p.length - 2);
      const reach = Math.hypot(next.x - base.x, next.y - base.y) * 0.4;
      for (const [id, o] of off) {
        const a = { x: base.x + n.x * (o + shift), y: base.y + n.y * (o + shift) };
        pts.push(a);
        rays.push({ e, id, a, out, reach });
      }
    }
    for (const c of corners) pts.push({ x: c.x, y: c.y });

    // Lines bending together from one edge onto another are joined smoothly,
    // so they do not need covering.
    const turnsTogether = (r, o) => r.id === o.id
      || (offsets.get(r.e.key).has(o.id) && offsets.get(o.e.key).has(r.id));
    const along = (r, t) => ({ x: r.a.x + r.out.x * t, y: r.a.y + r.out.y * t });
    const step = Math.max(1, style.lineWidth / 3);
    for (const r of rays) {
      const others = rays.filter((o) => o.e !== r.e && !turnsTogether(r, o));
      let extent = 0;
      for (let t = step; t <= r.reach; t += step) {
        const q = along(r, t);
        const touches = others.some((o) => {
          const end = along(o, o.reach);
          return distanceToSegment(q.x, q.y, o.a.x, o.a.y, end.x, end.y) < style.touch;
        });
        if (touches) extent = t;
      }
      if (extent) pts.push(along(r, extent));
    }
    return pts;
  }

  // Station records with their marker shape and bounds; stations without a
  // visible line are skipped.
  function buildStations(graph, layout, tracks, stationCorners, style) {
    const stations = new Map();
    for (const s of graph.stations.values()) {
      const lines = new Set();
      for (const e of s.edges) for (const l of tracks.edgeLines.get(e.key)) lines.add(l);
      if (!lines.size) continue;
      const pts = markerPoints(s, tracks, stationCorners.get(s.id) || [], style);
      const pos = layout.pos.get(s.id);
      stations.set(s.id, {
        station: s,
        center: { x: pos.x * style.unit, y: pos.y * style.unit },
        hull: convexHull(pts, (p) => `${fmt(p.x)},${fmt(p.y)}`),
        lines: [...lines],
        transfer: false,
      });
    }
    for (const t of graph.transfers) {
      if (!stations.has(t.a) || !stations.has(t.b)) continue;
      stations.get(t.a).transfer = true;
      stations.get(t.b).transfer = true;
    }

    // Interchanges get a rounded rectangle covering all their lines; other
    // stations a circle.
    const { markerR, border } = style;
    for (const s of stations.values()) {
      s.interchange = s.lines.length > 1 || s.transfer || s.station.labels.length > 1;
      if (s.interchange) {
        s.shape = orientedRect(s.hull, markerR + border / 2);
      } else {
        const n = s.hull.length;
        const c = s.hull.reduce((a, p) => ({ x: a.x + p.x / n, y: a.y + p.y / n }), { x: 0, y: 0 });
        s.shape = { kind: 'circle', cx: c.x, cy: c.y, r: markerR };
      }
      s.box = shapeBounds(s.shape, border / 2);
    }
    return stations;
  }

  // Transfer connectors are drawn in two layers, outline below the markers and
  // white fill above, so connected markers read as one shape.
  function drawStations(root, stations, transfers, style, obstacles) {
    const { markerR, border } = style;
    const gConnectors = el('g', { class: 'connectors' }, root);
    const gMarkers = el('g', { class: 'markers' }, root);
    const gConnectorFill = el('g', { class: 'connectors-fill' }, root);

    const linkR = markerR * 0.6;
    for (const t of transfers) {
      const a = stations.get(t.a);
      const b = stations.get(t.b);
      const d = `M${pt(a.center)}L${pt(b.center)}`;
      const lines = lineIds([...new Set([...a.lines, ...b.lines])]);
      el('path', { d, class: 'transfer', stroke: INK, 'stroke-width': fmt(2 * (linkR + border)), 'data-lines': lines }, gConnectors);
      el('path', { d, class: 'transfer', stroke: '#fff', 'stroke-width': fmt(2 * linkR), 'data-lines': lines }, gConnectorFill);
      obstacles.push([a.center, b.center]);
    }

    for (const [id, s] of stations) {
      const common = {
        class: 'marker',
        fill: '#fff',
        'stroke-width': fmt(border),
        'data-station': id,
        'data-lines': lineIds(s.lines),
      };
      const sh = s.shape;
      if (sh.kind === 'circle') {
        el('circle', { ...common, cx: fmt(sh.cx), cy: fmt(sh.cy), r: fmt(sh.r), stroke: s.lines[0].color }, gMarkers);
      } else {
        el('rect', {
          ...common,
          x: fmt(-sh.w / 2),
          y: fmt(-sh.h / 2),
          width: fmt(sh.w),
          height: fmt(sh.h),
          rx: fmt(Math.min(sh.w, sh.h) * 0.32),
          transform: `translate(${fmt(sh.cx)} ${fmt(sh.cy)}) rotate(${fmt(sh.angle)})`,
          stroke: INK,
        }, gMarkers);
      }
    }
  }

  function drawLabels(root, labels) {
    const gLabels = el('g', { class: 'labels' }, root);
    for (const { station: s, rect, lines, anchor, bold } of labels) {
      const x = anchor === 'start' ? rect.x0 : anchor === 'end' ? rect.x1 : (rect.x0 + rect.x1) / 2;
      const text = el('text', {
        class: `label${bold ? ' bold' : ''}`,
        'text-anchor': anchor,
        'data-station': s.station.id,
        'data-lines': lineIds(s.lines),
      }, gLabels);
      lines.forEach((t, i) => {
        const span = el('tspan', { x: fmt(x), y: fmt(rect.y0 + FONT.size * 0.9 + i * FONT.lineHeight) }, text);
        span.textContent = t;
      });
    }
  }

  // Draws the map into `root`. Options: lineWidth, gap, hidden (Set of line ids),
  // showLabels. Returns the drawing's bounds and per-station info (keyed by id).
  function render(root, graph, layout, opts) {
    const style = computeStyle(graph, opts);
    const hidden = opts.hidden || new Set();
    const visible = graph.lines.filter((l) => !hidden.has(l.id));
    const tracks = MM.planTracks(graph, layout, visible, style);

    const obstacles = []; // drawn segments [p, q] that labels should avoid
    const stationCorners = drawLines(root, visible, tracks, style, obstacles);
    const stations = buildStations(graph, layout, tracks, stationCorners, style);
    const transfers = graph.transfers.filter((t) => stations.has(t.a) && stations.has(t.b));
    drawStations(root, stations, transfers, style, obstacles);

    const labels = opts.showLabels !== false ? MM.placeLabels([...stations.values()], obstacles) : [];
    if (labels.length) drawLabels(root, labels);

    const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const grow = (r) => {
      bounds.x0 = Math.min(bounds.x0, r.x0);
      bounds.y0 = Math.min(bounds.y0, r.y0);
      bounds.x1 = Math.max(bounds.x1, r.x1);
      bounds.y1 = Math.max(bounds.y1, r.y1);
    };
    for (const s of stations.values()) grow(s.box);
    for (const l of labels) grow(l.rect);
    for (const [p, q] of obstacles) {
      grow({ x0: Math.min(p.x, q.x), y0: Math.min(p.y, q.y), x1: Math.max(p.x, q.x), y1: Math.max(p.y, q.y) });
    }
    return { bounds, info: stations, offsets: tracks.offsets };
  }

  MM.render = render;
  MM.MAP_CSS = MAP_CSS;
})((window.MetroMap = window.MetroMap || {}));
