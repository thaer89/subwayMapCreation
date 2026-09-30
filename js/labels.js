(function (MM) {
  'use strict';

  const { segmentHitsRect, rectsOverlap } = MM.geometry;

  const FONT = {
    family: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    size: 12,
    lineHeight: 12 * 1.15,
  };
  const fontFor = (bold) => `${bold ? 700 : 500} ${FONT.size}px ${FONT.family}`;

  // Distance between a marker and a label placed straight beside it.
  const GAP = 4;
  // Candidate label positions around a marker's bounds `b`, in order of
  // preference. `place` returns the label's top-left corner for a w×h label.
  const POSITIONS = [
    { cost: 0, anchor: 'start', place: (b, w, h) => [b.x1 + GAP, midY(b) - h / 2] }, // E
    { cost: 0.3, anchor: 'end', place: (b, w, h) => [b.x0 - GAP - w, midY(b) - h / 2] }, // W
    { cost: 0.7, anchor: 'start', place: (b, w, h) => [b.x1, b.y0 - h] }, // NE
    { cost: 0.7, anchor: 'start', place: (b) => [b.x1, b.y1] }, // SE
    { cost: 0.9, anchor: 'end', place: (b, w, h) => [b.x0 - w, b.y0 - h] }, // NW
    { cost: 0.9, anchor: 'end', place: (b, w) => [b.x0 - w, b.y1] }, // SW
    { cost: 1.1, anchor: 'middle', place: (b, w, h) => [midX(b) - w / 2, b.y0 - GAP - h] }, // N
    { cost: 1.1, anchor: 'middle', place: (b, w) => [midX(b) - w / 2, b.y1 + GAP] }, // S
  ];
  const PENALTY = {
    variant: 0.6, // per step away from the preferred wording / line split
    crossesLine: 10,
    coversMarker: 20,
    coversLabel: 40,
  };

  function midX(b) {
    return (b.x0 + b.x1) / 2;
  }
  function midY(b) {
    return (b.y0 + b.y1) / 2;
  }

  let measureCtx = null;
  function textWidth(text, font) {
    measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  }

  // Ways to write a single name: on one line, or split over two lines at the
  // most balanced word break (or at a hyphen for single words).
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

  // Each variant is a list of text lines; earlier variants are preferred.
  function labelVariants(station) {
    const names = station.labels;
    return names.length > 1 ? [names, [names.join(' / ')]] : splitLabel(station.label);
  }

  // Greedily places a label for each station (busiest first) at the candidate
  // position that collides least with `obstacles` (line segments [p, q]),
  // station markers and labels placed so far. Stations need `station`, `box`,
  // `lines` and `interchange` (drawn bold).
  // Returns [{ station, rect, lines, anchor, bold }].
  function placeLabels(stations, obstacles) {
    const markerBoxes = stations.map((s) => ({ id: s.station.id, box: s.box }));
    const ordered = stations.slice().sort(
      (a, b) => b.lines.length - a.lines.length || b.station.edges.length - a.station.edges.length,
    );
    const placed = [];

    const addCollisions = (cost, rect, stationId) => {
      const shrunk = { x0: rect.x0 + 1, y0: rect.y0 + 1, x1: rect.x1 - 1, y1: rect.y1 - 1 };
      for (const [p, q] of obstacles) if (segmentHitsRect(p.x, p.y, q.x, q.y, shrunk)) cost += PENALTY.crossesLine;
      for (const m of markerBoxes) if (m.id !== stationId && rectsOverlap(m.box, shrunk)) cost += PENALTY.coversMarker;
      for (const r of placed) if (rectsOverlap(r.rect, shrunk)) cost += PENALTY.coversLabel;
      return cost;
    };

    for (const s of ordered) {
      const bold = s.interchange;
      const font = fontFor(bold);
      let best = null;
      labelVariants(s.station).forEach((lines, variant) => {
        const w = Math.max(...lines.map((t) => textWidth(t, font)));
        const h = lines.length * FONT.lineHeight;
        for (const pos of POSITIONS) {
          const [x0, y0] = pos.place(s.box, w, h);
          const rect = { x0, y0, x1: x0 + w, y1: y0 + h };
          const cost = addCollisions(pos.cost + variant * PENALTY.variant, rect, s.station.id);
          if (!best || cost < best.cost) best = { cost, rect, lines, anchor: pos.anchor };
        }
      });
      placed.push({ station: s, rect: best.rect, lines: best.lines, anchor: best.anchor, bold });
    }
    return placed;
  }

  MM.FONT = FONT;
  MM.placeLabels = placeLabels;
})((window.MetroMap = window.MetroMap || {}));
