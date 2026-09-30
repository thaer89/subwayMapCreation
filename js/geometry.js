(function (MM) {
  'use strict';

  const EPS = 1e-9;

  // ---- Vectors ({ x, y }) ---------------------------------------------------
  const sub = (u, v) => ({ x: u.x - v.x, y: u.y - v.y });
  const dot = (u, v) => u.x * v.x + u.y * v.y;
  const cross = (u, v) => u.x * v.y - u.y * v.x;

  function unitVec(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    return { x: dx / L, y: dy / L };
  }

  // Left-hand normal in y-down screen space.
  const leftNormal = (d) => ({ x: d.y, y: -d.x });

  function distanceToSegment(px, py, ax, ay, bx, by) {
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
    return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
  }

  // ---- Flat polylines ([x0, y0, x1, y1, ...]) ----------------------------------
  function orient(ax, ay, bx, by, cx, cy) {
    const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    return v > EPS ? 1 : v < -EPS ? -1 : 0;
  }

  function onSegment(ax, ay, bx, by, cx, cy) {
    return (
      Math.min(ax, bx) - EPS <= cx && cx <= Math.max(ax, bx) + EPS &&
      Math.min(ay, by) - EPS <= cy && cy <= Math.max(ay, by) + EPS
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
      best = Math.min(best, distanceToSegment(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]));
    }
    return best;
  }

  // Returns [minX, minY, maxX, maxY].
  function polylineBounds(p) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      if (p[i] < x0) x0 = p[i];
      if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1];
      if (p[i + 1] > y1) y1 = p[i + 1];
    }
    return [x0, y0, x1, y1];
  }

  // ---- Rectangles ({ x0, y0, x1, y1 }) and shapes ------------------------------
  const rectsOverlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

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

  // `key` identifies duplicate points (e.g. after rounding).
  function convexHull(points, key) {
    const uniq = new Map();
    for (const p of points) uniq.set(key(p), p);
    const pts = [...uniq.values()].sort((a, b) => a.x - b.x || a.y - b.y);
    if (pts.length < 3) return pts;
    const turn = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const halfHull = (ordered) => {
      const hull = [];
      for (const p of ordered) {
        while (hull.length >= 2 && turn(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
        hull.push(p);
      }
      return hull.slice(0, -1);
    };
    return halfHull(pts).concat(halfHull(pts.slice().reverse()));
  }

  // Smallest rectangle (padded by `pad`) around `points`, trying octilinear
  // orientations first and then the edge directions of `points` taken as a hull.
  // `angle` is in degrees; (cx, cy) is the centre.
  function orientedRect(points, pad) {
    const angles = [0, Math.PI / 4];
    for (let i = 0; i < points.length && points.length > 1; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      angles.push(Math.atan2(b.y - a.y, b.x - a.x));
    }
    let best = null;
    for (const angle of angles) {
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const p of points) {
        const u = p.x * c + p.y * s;
        const v = -p.x * s + p.y * c;
        u0 = Math.min(u0, u); u1 = Math.max(u1, u);
        v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      }
      const w = u1 - u0 + 2 * pad;
      const h = v1 - v0 + 2 * pad;
      if (best && w * h >= best.w * best.h - 1) continue;
      const uc = (u0 + u1) / 2;
      const vc = (v0 + v1) / 2;
      best = { kind: 'rect', cx: uc * c - vc * s, cy: uc * s + vc * c, w, h, angle: (angle * 180) / Math.PI };
    }
    return best;
  }

  // Axis-aligned bounds of a circle or oriented rect, grown by `extra`.
  function shapeBounds(sh, extra) {
    if (sh.kind === 'circle') {
      const r = sh.r + extra;
      return { x0: sh.cx - r, y0: sh.cy - r, x1: sh.cx + r, y1: sh.cy + r };
    }
    const a = (sh.angle * Math.PI) / 180;
    const hw = sh.w / 2 + extra;
    const hh = sh.h / 2 + extra;
    const ex = Math.abs(Math.cos(a)) * hw + Math.abs(Math.sin(a)) * hh;
    const ey = Math.abs(Math.sin(a)) * hw + Math.abs(Math.cos(a)) * hh;
    return { x0: sh.cx - ex, y0: sh.cy - ey, x1: sh.cx + ex, y1: sh.cy + ey };
  }

  MM.geometry = {
    sub,
    dot,
    cross,
    unitVec,
    leftNormal,
    distanceToSegment,
    polylinesIntersect,
    distanceToPolyline,
    polylineBounds,
    rectsOverlap,
    segmentHitsRect,
    convexHull,
    orientedRect,
    shapeBounds,
  };
})((window.MetroMap = window.MetroMap || {}));
