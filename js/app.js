(function (MM) {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const svg = $('#map');
  const viewport = $('#viewport');
  const tooltip = $('#tooltip');
  const message = $('#message');

  const state = {
    graph: null,
    schematic: null,
    geographic: null,
    mode: 'schematic',
    hidden: new Set(),
    seed: 1,
    lineWidth: 6,
    showLabels: true,
    result: null,
    source: '',
  };
  const view = { x: 0, y: 0, k: 1 };

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function showMessage(html) {
    message.innerHTML = html;
    message.hidden = !html;
  }

  function load(data, source) {
    try {
      state.graph = MM.buildGraph(data);
    } catch (err) {
      showMessage(`<strong>Could not read ${escapeHtml(source)}.</strong><br>${escapeHtml(err.message)}`);
      return;
    }
    state.source = source;
    state.hidden.clear();
    state.seed = 1;
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
      hidden: state.hidden,
      showLabels: state.showLabels,
    });
    const g = state.graph;
    const stats = currentLayout().stats;
    $('#subtitle').textContent =
      `${g.stations.size} stations · ${g.lines.length} lines` +
      (stats ? ` · ${stats.crossings} crossings` : '') +
      (state.source ? ` · ${state.source}` : '');
    if (fit) fitView();
  }

  function buildLegend() {
    const ul = $('#legend');
    ul.replaceChildren();
    for (const line of state.graph.lines) {
      const li = document.createElement('li');
      li.className = state.hidden.has(line.id) ? 'off' : '';
      li.innerHTML = '<span class="swatch"></span><span class="name"></span><span class="count"></span>';
      li.querySelector('.swatch').style.setProperty('--c', line.color);
      li.querySelector('.name').textContent = line.name;
      li.querySelector('.count').textContent = line.adj.size;
      li.title = 'Click to show / hide';
      li.addEventListener('click', () => {
        if (state.hidden.has(line.id)) state.hidden.delete(line.id);
        else state.hidden.add(line.id);
        li.classList.toggle('off', state.hidden.has(line.id));
        draw(false);
      });
      li.addEventListener('mouseenter', () => highlight(line.id));
      li.addEventListener('mouseleave', () => highlight(null));
      ul.appendChild(li);
    }
  }

  function highlight(lineId) {
    svg.querySelectorAll('.active').forEach((n) => n.classList.remove('active'));
    svg.classList.toggle('dim', lineId != null);
    if (lineId == null) return;
    const v = CSS.escape(String(lineId));
    svg.querySelectorAll(`[data-line="${v}"], [data-lines~="${v}"]`).forEach((n) => n.classList.add('active'));
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
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('dragging');
  });
  svg.addEventListener('pointermove', (e) => {
    if (drag) {
      view.x = drag.vx + e.clientX - drag.x;
      view.y = drag.vy + e.clientY - drag.y;
      applyView();
      return;
    }
    const target = e.target.closest && e.target.closest('[data-station]');
    if (!target || !state.result) {
      tooltip.hidden = true;
      return;
    }
    const s = [...state.result.info.values()].find((i) => String(i.station.id) === target.dataset.station);
    if (!s) return;
    tooltip.innerHTML =
      `<strong>${escapeHtml(s.station.label)}</strong>` +
      s.lines.map((l) => `<span class="chip"><i style="background:${l.color}"></i>${escapeHtml(l.name)}</span>`).join('');
    tooltip.hidden = false;
    tooltip.style.left = `${e.clientX + 14}px`;
    tooltip.style.top = `${e.clientY + 14}px`;
  });
  const endDrag = () => {
    drag = null;
    svg.classList.remove('dragging');
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('pointerleave', () => (tooltip.hidden = true));

  const zoomCenter = (f) => {
    const r = svg.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, f);
  };
  $('#zoomIn').addEventListener('click', () => zoomCenter(1.25));
  $('#zoomOut').addEventListener('click', () => zoomCenter(0.8));
  $('#zoomFit').addEventListener('click', fitView);
  window.addEventListener('resize', fitView);

  // ---- Controls --------------------------------------------------------------
  document.querySelectorAll('.segmented button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode;
      document.querySelectorAll('.segmented button').forEach((b) => b.classList.toggle('active', b === btn));
      draw(true);
    });
  });
  $('#lineWidth').addEventListener('input', (e) => {
    state.lineWidth = Number(e.target.value);
    draw(false);
  });
  $('#showLabels').addEventListener('change', (e) => {
    state.showLabels = e.target.checked;
    draw(false);
  });
  $('#relayout').addEventListener('click', () => {
    if (!state.graph) return;
    state.seed++;
    computeSchematic(false);
  });

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
