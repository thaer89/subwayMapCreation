(function (MM) {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const svg = $('#map');
  const viewport = $('#viewport');
  const tooltip = $('#tooltip');
  const message = $('#message');
  const focusBar = $('#focusBar');

  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = MM.MAP_CSS;
  svg.insertBefore(style, viewport);

  const state = {
    raw: null,
    graph: null,
    schematic: null,
    geographic: null,
    mode: 'schematic',
    hidden: new Set(),
    seed: 1,
    lineWidth: 6,
    gap: 2,
    showLabels: true,
    mergeNearby: false,
    result: null,
    source: '',
    focus: null, // { type: 'station' | 'line', id: string }
    hover: null, // line id hovered in the legend
  };
  const view = { x: 0, y: 0, k: 1 };

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const lineChip = (l) => `<span class="chip"><i style="background:${l.color}"></i>${escapeHtml(l.name)}</span>`;

  function showMessage(html) {
    message.innerHTML = html;
    message.hidden = !html;
  }

  function load(data, source) {
    state.raw = data;
    state.source = source;
    state.hidden.clear();
    rebuild();
  }

  function rebuild() {
    try {
      state.graph = MM.buildGraph(state.mergeNearby ? MM.mergeNearby(state.raw) : state.raw);
    } catch (err) {
      showMessage(`<strong>Could not read ${escapeHtml(state.source)}.</strong><br>${escapeHtml(err.message)}`);
      return;
    }
    state.seed = 1;
    state.focus = null;
    state.geographic = MM.layoutGeographic(state.graph);
    buildLegend();
    computeSchematic(true);
  }

  function computeSchematic(fit) {
    showMessage('Computing schematic layout…');
    setTimeout(() => {
      state.schematic = MM.layoutSchematic(state.graph, { seed: state.seed });
      showMessage('');
      draw(fit);
    }, 30);
  }

  function currentLayout() {
    return state.mode === 'schematic' ? state.schematic : state.geographic;
  }

  function draw(fit) {
    if (!state.graph || !currentLayout()) return;
    viewport.replaceChildren();
    state.result = MM.render(viewport, state.graph, currentLayout(), {
      lineWidth: state.lineWidth,
      gap: state.gap,
      hidden: state.hidden,
      showLabels: state.showLabels,
    });
    const g = state.graph;
    const stats = currentLayout().stats;
    $('#subtitle').textContent =
      `${g.stations.size} stations · ${g.lines.length} lines` +
      (stats ? ` · ${stats.crossings} crossings` : '') +
      (state.source ? ` · ${state.source}` : '');
    if (state.focus && !focusedLines()) state.focus = null;
    applyHighlight();
    if (fit) fitView();
  }

  function stationInfo(id) {
    if (!state.result) return null;
    for (const s of state.result.info.values()) if (String(s.station.id) === id) return s;
    return null;
  }
  const lineById = (id) => state.graph.lines.find((l) => String(l.id) === id);

  // ---- Focus & highlight -----------------------------------------------------
  function focusedLines() {
    const f = state.focus;
    if (!f) return null;
    if (f.type === 'line') return lineById(f.id) && !state.hidden.has(lineById(f.id).id) ? new Set([f.id]) : null;
    const s = stationInfo(f.id);
    return s ? new Set(s.lines.map((l) => String(l.id))) : null;
  }

  function applyHighlight() {
    svg.querySelectorAll('.active').forEach((n) => n.classList.remove('active'));
    const set = state.hover != null ? new Set([state.hover]) : focusedLines();
    svg.classList.toggle('dim', !!set);
    if (set) {
      svg.querySelectorAll('[data-line]').forEach((n) => {
        if (set.has(n.dataset.line)) n.classList.add('active');
      });
      svg.querySelectorAll('[data-lines]').forEach((n) => {
        if (n.dataset.lines.split(' ').some((id) => set.has(id))) n.classList.add('active');
      });
    }
    document.querySelectorAll('#legend li').forEach((li) => {
      li.classList.toggle('focused', !!set && set.has(li.dataset.line));
    });
    updateFocusBar();
  }

  function updateFocusBar() {
    const f = state.focus;
    const set = focusedLines();
    if (!f || !set) {
      focusBar.hidden = true;
      return;
    }
    const title = f.type === 'line'
      ? escapeHtml(lineById(f.id).name)
      : escapeHtml(stationInfo(f.id).station.labels.join(' / '));
    const chips = [...set].map(lineById).map(lineChip).join('');
    focusBar.innerHTML =
      `<span class="focus-title">${f.type === 'line' ? 'Line' : 'Station'}: <strong>${title}</strong></span>` +
      (f.type === 'station' ? `<span class="chips">${chips}</span>` : '') +
      '<button type="button" id="clearFocus" title="Show all lines (Esc)">Show all</button>';
    focusBar.hidden = false;
    $('#clearFocus').addEventListener('click', () => setFocus(null));
  }

  function setFocus(focus) {
    const same = focus && state.focus && focus.type === state.focus.type && focus.id === state.focus.id;
    state.focus = same ? null : focus;
    applyHighlight();
  }

  function handleMapClick(x, y) {
    const target = document.elementFromPoint(x, y);
    const station = target && target.closest && target.closest('[data-station]');
    if (station) return setFocus({ type: 'station', id: station.dataset.station });
    const line = target && target.closest && target.closest('[data-line]');
    if (line) return setFocus({ type: 'line', id: line.dataset.line });
    setFocus(null);
  }

  // ---- Legend ----------------------------------------------------------------
  function buildLegend() {
    const ul = $('#legend');
    ul.replaceChildren();
    for (const line of state.graph.lines) {
      const li = document.createElement('li');
      li.dataset.line = String(line.id);
      li.classList.toggle('off', state.hidden.has(line.id));
      li.innerHTML =
        '<button type="button" class="eye" title="Show / hide line"></button>' +
        '<span class="swatch"></span><span class="name"></span><span class="count"></span>';
      li.querySelector('.swatch').style.setProperty('--c', line.color);
      li.querySelector('.name').textContent = line.name;
      li.querySelector('.count').textContent = line.adj.size;
      li.title = 'Click to show only this line';
      li.querySelector('.eye').addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.hidden.has(line.id)) state.hidden.delete(line.id);
        else state.hidden.add(line.id);
        li.classList.toggle('off', state.hidden.has(line.id));
        draw(false);
      });
      li.addEventListener('click', () => {
        if (!state.hidden.has(line.id)) setFocus({ type: 'line', id: String(line.id) });
      });
      li.addEventListener('mouseenter', () => {
        if (state.hidden.has(line.id)) return;
        state.hover = String(line.id);
        applyHighlight();
      });
      li.addEventListener('mouseleave', () => {
        state.hover = null;
        applyHighlight();
      });
      ul.appendChild(li);
    }
  }

  // ---- Pan & zoom ------------------------------------------------------------
  function applyView() {
    viewport.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
  }

  function fitView() {
    if (!state.result) return;
    const b = state.result.bounds;
    const rect = svg.getBoundingClientRect();
    const panel = $('.panel').getBoundingClientRect();
    const left = rect.width > 900 ? panel.right + 16 : 16;
    const availW = rect.width - left - 32;
    const availH = rect.height - 48;
    const w = b.x1 - b.x0 || 1;
    const h = b.y1 - b.y0 || 1;
    view.k = Math.min(availW / w, availH / h, 3);
    view.x = left + (availW - w * view.k) / 2 - b.x0 * view.k + 16;
    view.y = 24 + (availH - h * view.k) / 2 - b.y0 * view.k;
    applyView();
  }

  function zoomAt(mx, my, factor) {
    const k = Math.max(0.1, Math.min(12, view.k * factor));
    view.x = mx - ((mx - view.x) * k) / view.k;
    view.y = my - ((my - view.y) * k) / view.k;
    view.k = k;
    applyView();
  }

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  let drag = null;
  svg.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (drag) {
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
      drag.moved = true;
      svg.classList.add('dragging');
      tooltip.hidden = true;
      view.x = drag.vx + e.clientX - drag.x;
      view.y = drag.vy + e.clientY - drag.y;
      applyView();
      return;
    }
    const target = e.target.closest && e.target.closest('[data-station]');
    const s = target && stationInfo(target.dataset.station);
    if (!s) {
      tooltip.hidden = true;
      return;
    }
    tooltip.innerHTML =
      s.station.labels.map((n) => `<strong>${escapeHtml(n)}</strong>`).join('') +
      s.lines.map(lineChip).join('');
    tooltip.hidden = false;
    tooltip.style.left = `${e.clientX + 14}px`;
    tooltip.style.top = `${e.clientY + 14}px`;
  });
  svg.addEventListener('pointerup', (e) => {
    if (drag && !drag.moved) handleMapClick(e.clientX, e.clientY);
    drag = null;
    svg.classList.remove('dragging');
  });
  svg.addEventListener('pointercancel', () => {
    drag = null;
    svg.classList.remove('dragging');
  });
  svg.addEventListener('pointerleave', () => (tooltip.hidden = true));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setFocus(null);
  });

  const zoomCenter = (f) => {
    const r = svg.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, f);
  };
  $('#zoomIn').addEventListener('click', () => zoomCenter(1.25));
  $('#zoomOut').addEventListener('click', () => zoomCenter(0.8));
  $('#zoomFit').addEventListener('click', fitView);
  window.addEventListener('resize', fitView);

  // ---- PNG export ------------------------------------------------------------
  function exportPng() {
    if (!state.result) return;
    const b = state.result.bounds;
    const margin = 48;
    const lines = state.graph.lines.filter((l) => !state.hidden.has(l.id));
    const rowH = 24;
    const legendW = 220;
    const legendH = 40 + lines.length * rowH;
    const mapW = b.x1 - b.x0;
    const width = mapW + legendW + margin * 3;
    const height = Math.max(b.y1 - b.y0, legendH) + margin * 2;

    const content = viewport.cloneNode(true);
    content.removeAttribute('transform');
    content.setAttribute('transform', `translate(${margin - b.x0} ${margin - b.y0})`);
    content.querySelectorAll('.hit').forEach((n) => n.remove());

    const lx = margin * 2 + mapW;
    const legend = lines
      .map((l, i) => {
        const y = margin + 40 + i * rowH;
        return `<rect x="${lx}" y="${y - 4}" width="28" height="8" rx="4" fill="${l.color}"/>` +
          `<text x="${lx + 40}" y="${y + 4}" class="legend">${escapeHtml(l.name)}</text>`;
      })
      .join('');

    const markup =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="${svg.classList.contains('dim') ? 'dim' : ''}">` +
      `<style>${MM.MAP_CSS} .line, .marker, .transfer, .label { transition: none; }` +
      ` .legend { font: 500 13px ${MM.FONT.family}; fill: #1b1b1b; }` +
      ` .legend-title { font: 700 15px ${MM.FONT.family}; fill: #1b1b1b; }</style>` +
      `<rect width="100%" height="100%" fill="#fff"/>` +
      new XMLSerializer().serializeToString(content) +
      `<text x="${lx}" y="${margin + 12}" class="legend-title">Lines</text>${legend}</svg>`;

    // Keep within Safari's canvas area limit.
    const scale = Math.min(2, Math.sqrt(16e6 / (width * height)));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${(state.source || 'metro-map').replace(/\.json$/i, '').replace(/[^\w.-]+/g, '_')}-${state.mode}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }, 'image/png');
    };
    img.onerror = () => showMessage('<strong>PNG export failed.</strong>');
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  }

  // ---- Controls --------------------------------------------------------------
  document.querySelectorAll('.segmented button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode;
      document.querySelectorAll('.segmented button').forEach((b) => b.classList.toggle('active', b === btn));
      draw(true);
    });
  });
  const bindRange = (id, key) => {
    const input = $(id);
    const out = input.parentElement.querySelector('output');
    const sync = () => {
      state[key] = Number(input.value);
      if (out) out.textContent = input.value;
    };
    sync();
    input.addEventListener('input', () => {
      sync();
      draw(false);
    });
  };
  bindRange('#lineWidth', 'lineWidth');
  bindRange('#lineGap', 'gap');
  $('#showLabels').addEventListener('change', (e) => {
    state.showLabels = e.target.checked;
    draw(false);
  });
  $('#mergeNearby').addEventListener('change', (e) => {
    state.mergeNearby = e.target.checked;
    if (state.raw) rebuild();
  });
  $('#relayout').addEventListener('click', () => {
    if (!state.graph) return;
    state.seed++;
    computeSchematic(false);
  });
  $('#exportPng').addEventListener('click', exportPng);

  function readFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        load(JSON.parse(reader.result), file.name);
      } catch (err) {
        showMessage(`<strong>${escapeHtml(file.name)} is not valid JSON.</strong><br>${escapeHtml(err.message)}`);
      }
    };
    reader.readAsText(file);
  }
  $('#fileInput').addEventListener('change', (e) => {
    if (e.target.files[0]) readFile(e.target.files[0]);
    e.target.value = '';
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
  });

  const params = new URLSearchParams(location.search);
  const dataUrl = params.get('data') || 'data1.json';
  fetch(dataUrl)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((data) => load(data, dataUrl))
    .catch(() => {
      showMessage(
        `<strong>Couldn't load <code>${escapeHtml(dataUrl)}</code> automatically.</strong><br>` +
          'Browsers block this when the page is opened as a file. Run <code>python3 -m http.server</code> ' +
          'in this folder and open <code>http://localhost:8000</code>, or drop a JSON file here / use “Load JSON”.'
      );
    });
})(window.MetroMap);
