/**
 * canvas.js — SVG drawing canvas and strip path management
 *
 * SVG layers:
 *   #imported-svg   reference artwork — each top-level <g> is a layer
 *   #strips-layer   LED strip path lines + in-progress ghost
 *   (canvas overlay managed by preview.js)
 *
 * Layer-based workflow:
 *   When an Illustrator SVG is imported as strips, the tool treats each top-level
 *   <g> as a distinct section. Its child <path> elements are concatenated into a
 *   single multi-subpath for length measurement and pixel placement. Each section
 *   becomes one LED strip. The artwork is also loaded as a dimmed reference so
 *   the physical layout is always visible beneath the LED overlay.
 *
 * Public API consumed by main.js:
 *   addStrip(strip)               render a strip from saved data
 *   selectStrip(id)               highlight strip + matching artwork layer
 *   deselectAll()                 clear strip selection + layer highlight
 *   deleteStrip(id)               remove from canvas + fire callback
 *   getPathEl(id)                 returns the <path> element
 *   nextColor()                   next palette colour for external strip creation
 *   setTool(tool)                 'draw' | 'select' | 'delete'
 *   toggleStripVisible(id)        toggle strip path + matching artwork layer
 *   setLayerHighlight(layerId)    dim all artwork layers except one
 *   clearLayerHighlight()         restore normal artwork opacity
 *   setArtworkOpacity(opacity)    overall artwork background opacity
 *   importSVG(text, asStrips)     import SVG file
 *   clearCanvas()                 remove all strips + reference art
 */
export class CanvasManager {
  /**
   * @param {SVGSVGElement} svgEl
   * @param {{
   *   onStripCreated:  function,
   *   onStripSelected: function,   // called with id or null on deselect
   *   onStripDeleted:  function,
   *   onImportRequest: function,   // called with parsed layer array
   *   getPitch:        function,   // () => mm
   *   getPxPerMm:      function,   // () => SVG units per mm
   * }} callbacks
   */
  constructor(svgEl, { onStripCreated, onStripSelected, onStripDeleted, onImportRequest, getPitch, getPxPerMm, onError, onPrompt, onLayerClick, onSubPathClick, onPathSelectionChange, onConnectionRequest, onStripMoved }) {
    this.svg = svgEl;
    this.onStripCreated        = onStripCreated;
    this.onStripSelected       = onStripSelected;
    this.onStripDeleted        = onStripDeleted;
    this.onImportRequest       = onImportRequest ?? (() => {});
    this.onError               = onError     ?? (msg => alert(msg));
    this.onPrompt              = onPrompt    ?? ((msg, def) => Promise.resolve(prompt(msg, def)));
    this.onLayerClick          = onLayerClick          ?? null;
    this.onSubPathClick        = onSubPathClick        ?? null;
    this.onPathSelectionChange = onPathSelectionChange ?? null;
    this.onConnectionRequest   = onConnectionRequest   ?? null;
    this.onStripMoved          = onStripMoved          ?? null;
    this._getPitch   = getPitch    ?? (() => 16.6);
    this._getPxPerMm = getPxPerMm  ?? (() => 2.8346);

    this.tool          = 'select';
    this._waypoints    = [];
    this._ghostPath    = null;
    this._ghostDots    = [];
    this.selectedId    = null;
    this._strips       = new Map(); // id → { g, pathEl, data }
    this._artworkOpacity = 0.5;    // artwork background opacity (0–1)

    this._palette = [
      '#ff6b6b','#ffd166','#06d6a0','#118ab2',
      '#ef476f','#ff9f1c','#2ec4b6','#a663cc',
      '#f77f00','#4cc9f0',
    ];
    this._paletteIdx = 0;

    this._draggingFrom   = null;
    this._ghostWire      = null;
    this._ghostWireStart = null;
    this._dragState      = null; // strip drag-to-move state

    this._initViewBox();
    this._setupEvents();
    this._addArrowMarker();
    this._addFilters();
  }

  // ── Sizing ────────────────────────────────────────────────────────────────

  _initViewBox() {
    const ro = new ResizeObserver(() => this._setViewBox());
    ro.observe(this.svg.parentElement);
    this._setViewBox();
  }

  _setViewBox() {
    // If artwork has been imported, keep its coordinate space so strip paths stay aligned.
    if (this._sourceViewBox) return;
    const w = this.svg.parentElement.clientWidth  || 800;
    const h = this.svg.parentElement.clientHeight || 600;
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.svg.setAttribute('width',  w);
    this.svg.setAttribute('height', h);
  }

  // ── Events ────────────────────────────────────────────────────────────────

  _setupEvents() {
    this.svg.addEventListener('click',       e => this._onClick(e));
    this.svg.addEventListener('dblclick',    e => this._onDblClick(e));
    this.svg.addEventListener('mousemove',   e => this._onMouseMove(e));
    this.svg.addEventListener('contextmenu', e => { e.preventDefault(); this._cancelDraw(); });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') this._cancelDraw();
    });

    // Strip drag-to-move
    document.addEventListener('mousemove', e => this._onStripDragMove(e));
    document.addEventListener('mouseup',   e => this._onStripDragEnd(e));
  }

  _pt(e) {
    const rect = this.svg.getBoundingClientRect();
    const vb   = this.svg.viewBox.baseVal;
    return {
      x: (e.clientX - rect.left) * (vb.width  / rect.width),
      y: (e.clientY - rect.top)  * (vb.height / rect.height),
    };
  }

  _onClick(e) {
    if (e.detail > 1) return;
    if (this.tool === 'draw') {
      this._waypoints.push(this._pt(e));
      this._renderGhost();
    } else if (this.tool === 'select') {
      // Click on blank canvas → deselect
      this.deselectAll();
      if (this._selPaths.length > 0) this.clearPathSelection();
    }
  }

  _onDblClick(e) {
    if (this.tool !== 'draw') return;
    if (this._waypoints.length < 2) { this._cancelDraw(); return; }
    this._waypoints.pop();
    this._finishDraw();
  }

  _onMouseMove(e) {
    const pt = this._pt(e);
    const el = document.getElementById('status-coords');
    if (el) el.textContent = `x: ${Math.round(pt.x)}, y: ${Math.round(pt.y)}`;
    if (this.tool === 'draw' && this._waypoints.length > 0) {
      this._stretchGhost(pt);
    }
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  _renderGhost() {
    this._clearGhost();
    const pts   = this._waypoints;
    if (!pts.length) return;
    const layer = this.svg.querySelector('#strips-layer');

    this._ghostPath = this._makePath(this._ptsToD(pts), '#555', 1.5);
    this._ghostPath.setAttribute('stroke-dasharray', '5 3');
    this._ghostPath.setAttribute('pointer-events', 'none');
    layer.appendChild(this._ghostPath);

    this._ghostDots = pts.map(p => {
      const c = this._makeCircle(p.x, p.y, 3.5, '#666');
      c.setAttribute('pointer-events', 'none');
      layer.appendChild(c);
      return c;
    });
  }

  _stretchGhost(cursor) {
    if (!this._ghostPath) return;
    this._ghostPath.setAttribute('d', this._ptsToD([...this._waypoints, cursor]));
  }

  _clearGhost() {
    this._ghostPath?.remove();  this._ghostPath = null;
    this._ghostDots.forEach(d => d.remove()); this._ghostDots = [];
  }

  _cancelDraw() {
    this._waypoints = [];
    this._clearGhost();
  }

  async _finishDraw() {
    const pathData = this._ptsToD(this._waypoints);
    this._cancelDraw();

    // Measure in a temp element so we can auto-calculate LED count
    const tempPath = this._makePath(pathData, 'transparent', 0);
    tempPath.setAttribute('pointer-events', 'none');
    this.svg.appendChild(tempPath);
    const svgLength  = tempPath.getTotalLength();
    this.svg.removeChild(tempPath);

    const pitch     = this._getPitch();
    const pxPerMm   = this._getPxPerMm();
    const autoCount = Math.max(1, Math.round(svgLength / (pitch * pxPerMm)));

    const defaultName = `Strip ${this._strips.size + 1}`;
    const name = await this.onPrompt(
      `Strip name  (auto: ${autoCount} LEDs @ ${pitch} mm pitch)`,
      defaultName,
    );
    if (name == null) return;

    const strip = {
      id: crypto.randomUUID(),
      name: name.trim() || defaultName,
      pathData,
      pixelCount: autoCount,
      svgLength,
      visible: true,
    };
    strip.color = this.nextColor();

    this.addStrip(strip);
    this.onStripCreated(strip);
  }

  _ptsToD(pts) {
    return `M ${pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L ')}`;
  }

  nextColor() {
    return this._palette[this._paletteIdx++ % this._palette.length];
  }

  // ── SVG element helpers ───────────────────────────────────────────────────

  _makePath(d, stroke, strokeWidth = 2) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d',               d);
    p.setAttribute('stroke',          stroke);
    p.setAttribute('stroke-width',    strokeWidth);
    p.setAttribute('fill',            'none');
    p.setAttribute('stroke-linecap',  'round');
    p.setAttribute('stroke-linejoin', 'round');
    return p;
  }

  _makeCircle(cx, cy, r, fill) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', cx); c.setAttribute('cy', cy);
    c.setAttribute('r',  r);  c.setAttribute('fill', fill);
    return c;
  }

  _makeConnector(cx, cy, fill, role) {
    const ns = 'http://www.w3.org/2000/svg';
    const g  = document.createElementNS(ns, 'g');
    g.setAttribute('class', `connector connector-${role}`);
    g.style.display = 'none';

    // Outer ring
    const ring = document.createElementNS(ns, 'circle');
    ring.setAttribute('r',    role === 'tail' ? '9' : '7');
    ring.setAttribute('fill', '#111');
    ring.setAttribute('stroke', fill);
    ring.setAttribute('stroke-width', '2');
    ring.setAttribute('cx', cx); ring.setAttribute('cy', cy);
    g.appendChild(ring);

    // Inner dot
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('r',    role === 'tail' ? '4' : '3');
    dot.setAttribute('fill', fill);
    dot.setAttribute('cx', cx); dot.setAttribute('cy', cy);
    g.appendChild(dot);

    // Role label (tiny text)
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('dominant-baseline', 'central');
    t.setAttribute('font-size', '6');
    t.setAttribute('fill', '#000');
    t.setAttribute('font-family', 'monospace');
    t.setAttribute('font-weight', 'bold');
    t.setAttribute('pointer-events', 'none');
    t.setAttribute('x', cx); t.setAttribute('y', cy);
    t.textContent = role === 'tail' ? '▶' : '●';
    g.appendChild(t);

    g.style.cursor = role === 'tail' ? 'grab' : 'crosshair';
    return g;
  }

  _connectorPos(connG) {
    const ring = connG.querySelector('circle');
    return { x: parseFloat(ring.getAttribute('cx')), y: parseFloat(ring.getAttribute('cy')) };
  }

  _setConnectorPos(connG, x, y) {
    connG.querySelectorAll('circle, text').forEach(el => {
      el.setAttribute('cx', x); el.setAttribute('cy', y);
      el.setAttribute('x',  x); el.setAttribute('y',  y);
    });
  }

  // ── Strip public API ──────────────────────────────────────────────────────

  addStrip(strip) {
    const layer = this.svg.querySelector('#strips-layer');
    const g     = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('data-strip-id', strip.id);

    // ── Visible path line ─────────────────────────────────────────────────────
    const pathEl = this._makePath(strip.pathData, strip.color, 3);
    pathEl.setAttribute('pointer-events', 'none');
    g.appendChild(pathEl);

    // ── Wide invisible hit target ─────────────────────────────────────────────
    // Sits on top of pathEl; catches clicks/hover across a generous stroke area.
    const hitPath = this._makePath(strip.pathData, strip.color, 14);
    hitPath.setAttribute('stroke-opacity', '0');
    hitPath.setAttribute('pointer-events', 'stroke');
    hitPath.style.cursor = 'pointer';
    hitPath.addEventListener('mouseenter', () => {
      pathEl.setAttribute('filter', 'url(#strip-glow)');
      pathEl.setAttribute('stroke-width', this.selectedId === strip.id ? '6' : '4.5');
    });
    hitPath.addEventListener('mouseleave', () => {
      pathEl.removeAttribute('filter');
      pathEl.setAttribute('stroke-width', this.selectedId === strip.id ? '5' : '3');
    });
    hitPath.addEventListener('click', e => {
      e.stopPropagation();
      if (this._dragState?.moved) return; // was a drag — don't select/delete
      if (this.tool === 'select') this.selectStrip(strip.id);
      if (this.tool === 'delete') this.deleteStrip(strip.id);
    });
    g.appendChild(hitPath);

    // ── LED dot circles group ─────────────────────────────────────────────────
    const dotsG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    dotsG.setAttribute('pointer-events', 'none');
    g.appendChild(dotsG);

    // ── Inline info label ─────────────────────────────────────────────────────
    const labelEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    labelEl.setAttribute('pointer-events', 'none');
    labelEl.setAttribute('fill', strip.color);
    labelEl.setAttribute('font-size', '11');
    labelEl.setAttribute('font-family', 'monospace');
    labelEl.setAttribute('opacity', '0');
    labelEl.setAttribute('text-anchor', 'middle');
    g.appendChild(labelEl);

    // ── Head connector (input — first pixel) ──────────────────────────────────
    const headC = this._makeConnector(0, 0, '#06d6a0', 'head');
    g.appendChild(headC);

    // ── Tail connector (output — last pixel) ─────────────────────────────────
    const tailC = this._makeConnector(0, 0, '#ff9f1c', 'tail');
    g.appendChild(tailC);

    layer.appendChild(g);
    this._strips.set(strip.id, { g, pathEl, hitPath, dotsG, labelEl, headC, tailC, data: strip });

    // Apply stored drag offset (from saved project or prior move)
    if (strip.offsetX || strip.offsetY) {
      g.setAttribute('transform', `translate(${strip.offsetX || 0},${strip.offsetY || 0})`);
    }

    // Strip drag-to-move: mousedown on hit target
    hitPath.addEventListener('mousedown', e => {
      if (this.tool !== 'select' || e.button !== 0) return;
      if (this._draggingFrom) return; // connector drag takes priority
      e.stopPropagation();
      e.preventDefault();
      const pt = this._pt(e);
      this._dragState = { id: strip.id, startX: pt.x, startY: pt.y, dx: 0, dy: 0, moved: false };
    });

    // Set up connector drag for node connections
    this._setupConnectorDrag(strip.id, headC, tailC);
    // Arrow and emit direction need path in DOM — call after appendChild
    this._updateStripArrow(strip.id);
    this.refreshEmitDirection(strip.id);
  }

  /**
   * Render LED dot circles and update connectors/label for a strip.
   * Call from main.js whenever pixel positions change.
   */
  setStripDots(id, pixels) {
    const entry = this._strips.get(id);
    if (!entry) return;
    entry._pixels = pixels; // cache for selectStrip/deselectAll refresh
    const { dotsG, labelEl, headC, tailC, data } = entry;
    const selected = this.selectedId === id;

    // Clear old dots
    dotsG.innerHTML = '';

    if (!pixels || !pixels.length) {
      headC.style.display = 'none';
      tailC.style.display = 'none';
      labelEl.setAttribute('opacity', '0');
      return;
    }

    // Draw LED dots
    const r   = selected ? 3.5 : 2;
    const opc = selected ? '0.85' : '0.28';
    pixels.forEach(px => {
      const c = this._makeCircle(px.x, px.y, r, data.color);
      c.setAttribute('opacity', opc);
      dotsG.appendChild(c);
    });

    // Position connectors
    const first = pixels[0], last = pixels[pixels.length - 1];
    this._setConnectorPos(headC, first.x, first.y);
    this._setConnectorPos(tailC, last.x,  last.y);
    headC.style.display = selected ? '' : 'none';
    tailC.style.display = selected ? '' : 'none';

    // Info label
    const mid = pixels[Math.floor(pixels.length / 2)];
    labelEl.setAttribute('x', mid.x);
    labelEl.setAttribute('y', mid.y - 14);
    const pxPerMm = this._getPxPerMm();
    const lenMm   = data.svgLength ? Math.round(data.svgLength / pxPerMm) : '?';
    labelEl.textContent = `${pixels.length} LEDs · ${lenMm}mm`;
    labelEl.setAttribute('opacity', selected ? '1' : '0.35');
  }

  // ── Strip drag-to-move ────────────────────────────────────────────────────

  _onStripDragMove(e) {
    if (!this._dragState) return;
    const pt = this._pt(e);
    const dx = pt.x - this._dragState.startX;
    const dy = pt.y - this._dragState.startY;
    if (!this._dragState.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    this._dragState.moved = true;
    this._dragState.dx = dx;
    this._dragState.dy = dy;
    const entry = this._strips.get(this._dragState.id);
    if (!entry) return;
    const ox = entry.data.offsetX || 0;
    const oy = entry.data.offsetY || 0;
    entry.g.setAttribute('transform', `translate(${(ox + dx).toFixed(1)},${(oy + dy).toFixed(1)})`);
    // Keep cursor grabbing across the whole window
    document.body.style.cursor = 'grabbing';
  }

  _onStripDragEnd(e) {
    if (!this._dragState) return;
    const { id, dx, dy, moved } = this._dragState;
    this._dragState = null;
    document.body.style.cursor = '';
    if (!moved) return;
    this.onStripMoved?.(id, dx, dy);
  }

  // ── Node connection system ─────────────────────────────────────────────────

  _setupConnectorDrag(stripId, headC, tailC) {
    // Only the TAIL connector initiates a drag (it's the "output")
    tailC.addEventListener('mousedown', e => {
      e.stopPropagation();
      if (this.tool !== 'select') return;
      this._startConnectionDrag(stripId, e);
    });

    // HEAD connector is the drop target — highlight on hover during drag
    headC.addEventListener('mouseenter', () => {
      if (this._draggingFrom) headC.querySelector('circle').setAttribute('stroke-width', '3.5');
    });
    headC.addEventListener('mouseleave', () => {
      headC.querySelector('circle').setAttribute('stroke-width', '2');
    });
    headC.addEventListener('mouseup', e => {
      if (!this._draggingFrom || this._draggingFrom === stripId) return;
      e.stopPropagation();
      this._finishConnectionDrag(stripId);
    });
  }

  _startConnectionDrag(fromId, e) {
    this._draggingFrom = fromId;
    const entry = this._strips.get(fromId);
    const startPt = this._connectorPos(entry.tailC);

    // Ghost wire
    const ns = 'http://www.w3.org/2000/svg';
    this._ghostWire = document.createElementNS(ns, 'path');
    this._ghostWire.setAttribute('stroke', '#ff9f1c');
    this._ghostWire.setAttribute('stroke-width', '2');
    this._ghostWire.setAttribute('stroke-dasharray', '6 3');
    this._ghostWire.setAttribute('fill', 'none');
    this._ghostWire.setAttribute('pointer-events', 'none');
    this.svg.querySelector('#connections-layer').appendChild(this._ghostWire);

    this._ghostWireStart = startPt;

    const onMove = e2 => {
      const pt = this._pt(e2);
      this._updateGhostWire(startPt, pt);
    };
    const onUp = e2 => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      this._ghostWire?.remove();
      this._ghostWire = null;
      this._draggingFrom = null;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  _updateGhostWire(from, to) {
    if (!this._ghostWire) return;
    const dx = to.x - from.x;
    const cpOffset = Math.min(Math.abs(dx) * 0.5, 120);
    const d = `M ${from.x},${from.y} C ${from.x + cpOffset},${from.y} ${to.x - cpOffset},${to.y} ${to.x},${to.y}`;
    this._ghostWire.setAttribute('d', d);
  }

  _finishConnectionDrag(toId) {
    const fromId = this._draggingFrom;
    if (!fromId || fromId === toId) return;
    this.onConnectionRequest?.(fromId, toId);
  }

  renderConnections(connections) {
    const layer = this.svg.querySelector('#connections-layer');
    if (!layer) return;
    layer.innerHTML = '';
    const ns = 'http://www.w3.org/2000/svg';

    connections.forEach(({ fromId, toId }) => {
      const fromEntry = this._strips.get(fromId);
      const toEntry   = this._strips.get(toId);
      if (!fromEntry || !toEntry) return;
      const from = this._connectorPos(fromEntry.tailC);
      const to   = this._connectorPos(toEntry.headC);
      if (!from.x && !from.y) return; // connectors not positioned yet

      const dx = to.x - from.x;
      const cpOff = Math.min(Math.abs(dx) * 0.5, 100);
      const d = `M ${from.x},${from.y} C ${from.x + cpOff},${from.y} ${to.x - cpOff},${to.y} ${to.x},${to.y}`;

      const wire = document.createElementNS(ns, 'path');
      wire.setAttribute('d', d);
      wire.setAttribute('stroke', '#ff9f1c');
      wire.setAttribute('stroke-width', '2.5');
      wire.setAttribute('fill', 'none');
      wire.setAttribute('opacity', '0.75');
      wire.setAttribute('marker-end', 'url(#arrow)');
      layer.appendChild(wire);
    });
  }

  _addFilters() {
    const ns = 'http://www.w3.org/2000/svg';
    let defs = this.svg.querySelector('defs');
    if (!defs) {
      defs = document.createElementNS(ns, 'defs');
      this.svg.insertBefore(defs, this.svg.firstChild);
    }

    const makeGlowFilter = (id, stdDev) => {
      const filter = document.createElementNS(ns, 'filter');
      filter.setAttribute('id', id);
      filter.setAttribute('x', '-80%'); filter.setAttribute('y', '-80%');
      filter.setAttribute('width', '260%'); filter.setAttribute('height', '260%');
      const blur = document.createElementNS(ns, 'feGaussianBlur');
      blur.setAttribute('stdDeviation', stdDev);
      blur.setAttribute('in', 'SourceGraphic');
      blur.setAttribute('result', 'blur');
      const merge = document.createElementNS(ns, 'feMerge');
      const n1 = document.createElementNS(ns, 'feMergeNode'); n1.setAttribute('in', 'blur');
      const n2 = document.createElementNS(ns, 'feMergeNode'); n2.setAttribute('in', 'SourceGraphic');
      merge.appendChild(n1); merge.appendChild(n2);
      filter.appendChild(blur); filter.appendChild(merge);
      defs.appendChild(filter);
    };

    makeGlowFilter('strip-glow', '3');
  }

  // ── Path selection ────────────────────────────────────────────────────────

  /** @type {Array<{layer: object, subPath: object, glowEls: SVGElement[]}>} */
  _selPaths = [];

  selectPath(layer, subPath, addToSelection) {
    if (!addToSelection) this._clearSelectionOverlay();

    // Toggle off if already selected
    const existing = this._selPaths.findIndex(s => s.subPath.pathId === subPath.pathId);
    if (existing >= 0) {
      this._selPaths[existing].glowEls.forEach(el => el.remove());
      this._selPaths.splice(existing, 1);
      this._applySelectionDim();
      this.onPathSelectionChange?.(this._selPaths.map(s => ({ layer: s.layer, subPath: s.subPath })));
      return;
    }

    const overlay = this.svg.querySelector('#selection-overlay');
    const ns = 'http://www.w3.org/2000/svg';
    const glowEls = [];

    const makeGlowPath = (d, strokeW, color, opacity) => {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', color);
      p.setAttribute('stroke-width', String(strokeW));
      p.setAttribute('stroke-opacity', String(opacity));
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('pointer-events', 'none');
      overlay?.appendChild(p);
      glowEls.push(p);
      return p;
    };

    const d = subPath.pathData;
    makeGlowPath(d, 10, '#4cc9f0', 0.18);  // outer bloom
    makeGlowPath(d, 5,  '#4cc9f0', 0.55);  // inner bloom
    makeGlowPath(d, 2,  '#ffffff', 1.0);   // bright core

    // Number badge at midpoint
    const num = this._selPaths.length + 1;
    const badge = this._makeSelectionBadge(subPath.pathData, num, ns);
    if (badge) { overlay?.appendChild(badge); glowEls.push(badge); }

    this._selPaths.push({ layer, subPath, glowEls });
    this._applySelectionDim();
    this.onPathSelectionChange?.(this._selPaths.map(s => ({ layer: s.layer, subPath: s.subPath })));
  }

  _makeSelectionBadge(pathData, num, ns) {
    // Place a numbered circle near the middle of the path
    const tempSvg = document.createElementNS(ns, 'svg');
    tempSvg.style.cssText = 'position:absolute;left:-9999px;visibility:hidden;pointer-events:none';
    const vb = this.svg.getAttribute('viewBox');
    if (vb) tempSvg.setAttribute('viewBox', vb);
    document.body.appendChild(tempSvg);
    const tp = document.createElementNS(ns, 'path');
    tp.setAttribute('d', pathData);
    tempSvg.appendChild(tp);
    let pt;
    try { pt = tp.getPointAtLength(tp.getTotalLength() * 0.5); } catch(e) { pt = null; }
    document.body.removeChild(tempSvg);
    if (!pt) return null;

    const g = document.createElementNS(ns, 'g');
    g.setAttribute('pointer-events', 'none');
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', pt.x); circle.setAttribute('cy', pt.y);
    circle.setAttribute('r', '10'); circle.setAttribute('fill', '#4cc9f0');
    circle.setAttribute('fill-opacity', '0.9');
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('x', pt.x); text.setAttribute('y', pt.y);
    text.setAttribute('text-anchor', 'middle'); text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('fill', '#000'); text.setAttribute('font-size', '10');
    text.setAttribute('font-weight', 'bold'); text.setAttribute('font-family', 'monospace');
    text.textContent = String(num);
    g.appendChild(circle); g.appendChild(text);
    return g;
  }

  _applySelectionDim() {
    const importedSvg = this.svg.querySelector('#imported-svg');
    if (!importedSvg) return;
    const SHAPE_SEL = 'path, rect, circle, ellipse, line, polyline, polygon';
    if (this._selPaths.length === 0) {
      importedSvg.style.opacity = String(this._artworkOpacity);
      importedSvg.querySelectorAll(SHAPE_SEL).forEach(el => { el.style.opacity = ''; });
      return;
    }
    importedSvg.style.opacity = '1';
    importedSvg.querySelectorAll(SHAPE_SEL).forEach(el => { el.style.opacity = '0.15'; });
    // Re-show artwork elements matching selected path data (split compound paths have matching d attrs)
    const selectedDs = new Set(this._selPaths.map(s => s.subPath.pathData?.trim()));
    importedSvg.querySelectorAll('path').forEach(el => {
      if (selectedDs.has(el.getAttribute('d')?.trim())) el.style.opacity = '0.45';
    });
  }

  clearPathSelection() {
    this._clearSelectionOverlay();
    this.onPathSelectionChange?.([]);
  }

  _clearSelectionOverlay() {
    this._selPaths.forEach(s => s.glowEls.forEach(el => el.remove()));
    this._selPaths = [];
    const importedSvg = this.svg.querySelector('#imported-svg');
    if (importedSvg) {
      importedSvg.style.opacity = String(this._artworkOpacity);
      importedSvg.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon')
        .forEach(el => { el.style.opacity = ''; });
    }
  }

  reorderSelection(fromIdx, toIdx) {
    if (fromIdx === toIdx) return;
    const [item] = this._selPaths.splice(fromIdx, 1);
    this._selPaths.splice(toIdx, 0, item);
    // Rebuild number badges
    const overlay = this.svg.querySelector('#selection-overlay');
    const ns = 'http://www.w3.org/2000/svg';
    this._selPaths.forEach((s, i) => {
      const badge = s.glowEls[s.glowEls.length - 1]; // last el is badge group
      if (badge && badge.tagName === 'g') {
        const text = badge.querySelector('text');
        if (text) text.textContent = String(i + 1);
      }
    });
    this.onPathSelectionChange?.(this._selPaths.map(s => ({ layer: s.layer, subPath: s.subPath })));
  }

  removeFromSelection(pathId) {
    const idx = this._selPaths.findIndex(s => s.subPath.pathId === pathId);
    if (idx < 0) return;
    this._selPaths[idx].glowEls.forEach(el => el.remove());
    this._selPaths.splice(idx, 1);
    // Renumber remaining badges
    this._selPaths.forEach((s, i) => {
      const badge = s.glowEls[s.glowEls.length - 1];
      if (badge && badge.tagName === 'g') {
        const text = badge.querySelector('text');
        if (text) text.textContent = String(i + 1);
      }
    });
    this._applySelectionDim();
    this.onPathSelectionChange?.(this._selPaths.map(s => ({ layer: s.layer, subPath: s.subPath })));
  }

  _addArrowMarker() {
    const ns   = 'http://www.w3.org/2000/svg';
    let defs = this.svg.querySelector('defs');
    if (!defs) {
      defs = document.createElementNS(ns, 'defs');
      this.svg.insertBefore(defs, this.svg.firstChild);
    }
    const marker = document.createElementNS(ns, 'marker');
    marker.setAttribute('id',          'arrow');
    marker.setAttribute('markerWidth', '8');
    marker.setAttribute('markerHeight','8');
    marker.setAttribute('refX',        '6');
    marker.setAttribute('refY',        '3');
    marker.setAttribute('orient',      'auto');
    const poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('points', '0 0, 8 3, 0 6');
    poly.setAttribute('fill',   '#ff9f1c');
    marker.appendChild(poly);
    defs.appendChild(marker);
  }

  selectStrip(id) {
    // Deselect previous
    if (this.selectedId && this.selectedId !== id) {
      const prev = this._strips.get(this.selectedId);
      if (prev) prev.pathEl.setAttribute('stroke-width', 3);
    }

    // Dim dots on previously selected strip
    if (this.selectedId && this.selectedId !== id) {
      const prevEntry = this._strips.get(this.selectedId);
      if (prevEntry) {
        prevEntry.headC.style.display = 'none';
        prevEntry.tailC.style.display = 'none';
        prevEntry.labelEl.setAttribute('opacity', '0.35');
        if (prevEntry._pixels) this.setStripDots(this.selectedId, prevEntry._pixels);
      }
    }
    this.selectedId = id;
    const entry = this._strips.get(id);
    if (entry?._pixels) this.setStripDots(id, entry._pixels);

    if (entry) {
      entry.pathEl.setAttribute('stroke-width', 5);
      // Send to back so the next click at the same spot hits the strip above
      const layer = this.svg.querySelector('#strips-layer');
      if (layer && layer.firstChild !== entry.g) {
        layer.insertBefore(entry.g, layer.firstChild);
      }
      const layerId = entry.data.layerId;
      if (layerId) {
        this.setLayerHighlight(layerId);
      } else {
        this.clearLayerHighlight();
      }
    }
    this.onStripSelected?.(id);
  }

  deselectAll() {
    if (this.selectedId) {
      const entry = this._strips.get(this.selectedId);
      if (entry) {
        entry.headC.style.display = 'none';
        entry.tailC.style.display = 'none';
        entry.labelEl.setAttribute('opacity', '0.35');
        if (entry._pixels) this.setStripDots(this.selectedId, entry._pixels);
      }
    }
    if (this.selectedId) {
      const prev = this._strips.get(this.selectedId);
      if (prev) prev.pathEl.setAttribute('stroke-width', 3);
      this.selectedId = null;
    }
    this.clearLayerHighlight();
    this.onStripSelected?.(null);
  }

  deleteStrip(id) {
    const entry = this._strips.get(id);
    if (!entry) return;
    entry.g.remove();
    this._strips.delete(id);
    if (this.selectedId === id) {
      this.selectedId = null;
      this.clearLayerHighlight();
    }
    this.onStripDeleted?.(id);
  }

  getPathEl(id) {
    return this._strips.get(id)?.pathEl ?? null;
  }

  /**
   * Toggle a strip's SVG path visibility AND its matching artwork layer.
   * Returns the new visible state.
   */
  toggleStripVisible(id) {
    const entry = this._strips.get(id);
    if (!entry) return true;

    const nowVisible = entry.g.style.display === 'none';
    entry.data.visible = nowVisible;
    entry.g.style.display = nowVisible ? '' : 'none';

    // Mirror into the artwork layer if this strip was imported from a layer
    if (entry.data.layerId) {
      const artEl = this._findArtworkLayer(entry.data.layerId);
      if (artEl) artEl.style.display = nowVisible ? '' : 'none';
    }

    return nowVisible;
  }

  setTool(tool) {
    this.tool = tool;
    if (tool !== 'draw') this._cancelDraw();
    const cursors = { draw: 'crosshair', select: 'default', delete: 'no-drop' };
    this.svg.style.cursor = cursors[tool] ?? 'default';
  }

  // ── Artwork layer highlighting ─────────────────────────────────────────────

  /**
   * Highlight one layer in the imported artwork: that layer shows at full
   * opacity while all siblings dim. The parent's opacity is overridden to 1
   * so the highlighted layer appears at true brightness.
   */
  setLayerHighlight(layerId) {
    const importedLayer = this.svg.querySelector('#imported-svg');
    if (!importedLayer?.children.length) return;

    importedLayer.style.opacity = '1';
    Array.from(importedLayer.children).forEach(child => {
      child.style.opacity = child.id === layerId ? '0.9' : '0.06';
    });
  }

  /** Restore the artwork to its normal uniform opacity. */
  clearLayerHighlight() {
    const importedLayer = this.svg.querySelector('#imported-svg');
    if (!importedLayer) return;
    importedLayer.style.opacity = String(this._artworkOpacity);
    Array.from(importedLayer.children).forEach(child => {
      child.style.opacity = '';
    });
  }

  /** Set the overall artwork background opacity (0–1). */
  setArtworkOpacity(opacity) {
    this._artworkOpacity = opacity;
    // Don't override while path selection is active
    if (this._selPaths?.length > 0) return;
    const importedLayer = this.svg.querySelector('#imported-svg');
    if (importedLayer) importedLayer.style.opacity = String(opacity);
  }

  /** Find a <g> element by id within the imported artwork layer. */
  _findArtworkLayer(layerId) {
    const importedLayer = this.svg.querySelector('#imported-svg');
    if (!importedLayer) return null;
    return Array.from(importedLayer.children).find(el => el.id === layerId) ?? null;
  }

  /** Show or hide an individual imported artwork layer on the canvas. */
  setArtworkLayerVisible(layerId, visible) {
    const el = this._findArtworkLayer(layerId);
    if (el) el.style.display = visible ? '' : 'none';
  }

  /** Show or hide a specific sub-path (compound path segment) by matching its d attribute. */
  setSubPathVisible(subPath, visible) {
    const importedSvg = this.svg.querySelector('#imported-svg');
    if (!importedSvg) return;
    const d = subPath.pathData?.trim();
    if (!d) return;
    importedSvg.querySelectorAll('path').forEach(el => {
      if (el.getAttribute('d')?.trim() === d) {
        el.style.display = visible ? '' : 'none';
      }
    });
  }

  // ── SVG import ────────────────────────────────────────────────────────────

  /**
   * Import an SVG file.
   *
   * asStrips=false → paste as dimmed reference background only.
   * asStrips=true  → ALSO load as reference background, then parse each top-level
   *                  <g> (Illustrator layer) and fire onImportRequest so the modal
   *                  can display measured lengths and LED counts for confirmation.
   */
  importSVG(svgText, asStrips) {
    const doc    = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const srcSvg = doc.querySelector('svg');
    if (!srcSvg) {
      this.onError('Could not parse SVG file.');
      return;
    }

    // Always load as reference background
    this._loadBackground(srcSvg);

    if (asStrips) {
      const layers = this._measureLayers(doc);
      if (!layers.length) {
        this.onError('No layer groups found in this SVG. Make sure you exported with layers from Illustrator (File → Export As → SVG).');
        return;
      }
      this.onImportRequest(layers);
    }
  }

  /**
   * Load the SVG's content into #imported-svg as a dimmed reference.
   * Adopts the source viewBox so the artwork fills the canvas correctly.
   *
   * <defs> (gradients, symbols, filters) are hoisted to the top-level SVG
   * so url(#id) references keep working inside the nested group.
   */
  _loadBackground(srcSvg) {
    const importedLayer = this.svg.querySelector('#imported-svg');
    importedLayer.innerHTML = '';

    // Remove any previously hoisted defs
    this.svg.querySelector('#imported-defs')?.remove();

    // Hoist <defs> to top-level SVG so references like url(#grad) still resolve
    const defsEl = srcSvg.querySelector('defs');
    if (defsEl) {
      const hoisted = defsEl.cloneNode(true);
      hoisted.id = 'imported-defs';
      this.svg.insertBefore(hoisted, this.svg.firstChild);
    }

    // Adopt the source viewBox so artwork fills canvas in its own coordinate space
    const vb = srcSvg.getAttribute('viewBox');
    if (vb) {
      this.svg.setAttribute('viewBox', vb);
      this._sourceViewBox = vb; // remember so ResizeObserver doesn't clobber it
      const parts = vb.trim().split(/[\s,]+/);
      if (parts.length === 4) {
        this.svg.setAttribute('width',  parts[2]);
        this.svg.setAttribute('height', parts[3]);
      }
    }

    // Clone all non-defs children into the artwork layer.
    // Compound paths (multiple M subpaths) are expanded into individual <path>
    // elements so each concentric line can be highlighted and hidden separately.
    const ns = 'http://www.w3.org/2000/svg';
    Array.from(srcSvg.children).forEach(child => {
      if (child.tagName.toLowerCase() === 'defs') return;
      const clone = child.cloneNode(true);
      // Expand compound paths inside groups
      if (clone.tagName.toLowerCase() === 'g') {
        clone.querySelectorAll('path').forEach(pathEl => {
          const d = pathEl.getAttribute('d') || '';
          const segments = this._splitCompoundPath(d);
          if (segments.length > 1) {
            // Replace compound path with one <path> per segment
            segments.forEach((seg, k) => {
              const p = pathEl.cloneNode(false);
              p.setAttribute('d', seg);
              p.setAttribute('data-subpath-id', `${clone.id || 'g'}-sp${k}`);
              pathEl.parentNode.insertBefore(p, pathEl);
            });
            pathEl.remove();
          }
        });
      }
      importedLayer.appendChild(clone);
    });

    importedLayer.style.opacity = String(this._artworkOpacity);
    importedLayer.style.filter = 'saturate(3) brightness(1.4)';
  }

  /**
   * Convert any SVG shape element to an equivalent path `d` string.
   * Handles: path, rect, circle, ellipse, line, polyline, polygon.
   * Returns '' for unsupported element types.
   */
  _shapeToD(el) {
    // Strip namespace prefix (e.g. svg:path → path)
    const tag = el.tagName.replace(/^[^:]+:/, '').toLowerCase();
    const n = a => parseFloat(el.getAttribute(a) || 0);

    switch (tag) {
      case 'path':
        return el.getAttribute('d') || '';

      case 'rect': {
        const x = n('x'), y = n('y'), w = n('width'), h = n('height');
        if (!w || !h) return '';
        let rx = parseFloat(el.getAttribute('rx') ?? el.getAttribute('ry') ?? 0);
        let ry = parseFloat(el.getAttribute('ry') ?? el.getAttribute('rx') ?? 0);
        rx = Math.min(Math.abs(rx), w / 2);
        ry = Math.min(Math.abs(ry), h / 2);
        if (rx || ry) {
          return `M ${x+rx},${y} H ${x+w-rx} A ${rx},${ry} 0 0 1 ${x+w},${y+ry}`
               + ` V ${y+h-ry} A ${rx},${ry} 0 0 1 ${x+w-rx},${y+h}`
               + ` H ${x+rx} A ${rx},${ry} 0 0 1 ${x},${y+h-ry}`
               + ` V ${y+ry} A ${rx},${ry} 0 0 1 ${x+rx},${y} Z`;
        }
        return `M ${x},${y} H ${x+w} V ${y+h} H ${x} Z`;
      }

      case 'circle': {
        const cx = n('cx'), cy = n('cy'), r = n('r');
        if (!r) return '';
        // Two-arc approximation of a full circle
        return `M ${cx-r},${cy} A ${r},${r} 0 1 0 ${cx+r},${cy} A ${r},${r} 0 1 0 ${cx-r},${cy} Z`;
      }

      case 'ellipse': {
        const cx = n('cx'), cy = n('cy'), rx = n('rx'), ry = n('ry');
        if (!rx || !ry) return '';
        return `M ${cx-rx},${cy} A ${rx},${ry} 0 1 0 ${cx+rx},${cy} A ${rx},${ry} 0 1 0 ${cx-rx},${cy} Z`;
      }

      case 'line':
        return `M ${n('x1')},${n('y1')} L ${n('x2')},${n('y2')}`;

      case 'polyline':
      case 'polygon': {
        const pts = (el.getAttribute('points') || '').trim()
          .split(/[\s,]+/).map(Number).filter((v, i, a) => !isNaN(v) && i < a.length - (a.length % 2 ? 1 : 0));
        if (pts.length < 4) return '';
        let d = `M ${pts[0]},${pts[1]}`;
        for (let i = 2; i < pts.length; i += 2) d += ` L ${pts[i]},${pts[i+1]}`;
        if (tag === 'polygon') d += ' Z';
        return d;
      }

      default:
        return '';
    }
  }

  /**
   * Split a compound path d-string (multiple M subpaths) into individual paths.
   * Illustrator exports often pack several concentric strokes into one <path>.
   */
  _splitCompoundPath(d) {
    // Match each M/m command and everything following it until the next M/m
    const parts = d.match(/[Mm][^Mm]*/g);
    if (!parts || parts.length <= 1) return [d];
    // Convert leading lowercase 'm' on standalone segments to absolute M
    // by measuring from origin (safe for Illustrator absolute-coordinate exports)
    return parts.map(p => p.trim()).filter(Boolean);
  }

  /**
   * Parse layers from an imported SVG document.
   * Returns: [{ layerId, name, pathData, svgLength }]
   *
   * Layer detection strategy (most-specific first):
   *   1. Top-level <g data-name> — Illustrator CC+ named layers
   *   2. Top-level <g> children of <svg>
   *   3. If only one top-level <g>, look one level deeper
   *
   * Shape support: path, rect, circle, ellipse, line, polyline, polygon.
   * All shapes are converted to path `d` strings for uniform length measurement.
   */
  _measureLayers(doc) {
    const srcSvg = doc.querySelector('svg');

    // Strategy 1 — Illustrator CC+: top-level <g data-name>
    let groups = Array.from(srcSvg.children).filter(
      el => el.tagName === 'g' && el.hasAttribute('data-name')
    );

    // Strategy 2 — any top-level <g>
    if (!groups.length) {
      groups = Array.from(srcSvg.children).filter(el => el.tagName === 'g');
    }

    // Strategy 3 — single wrapper <g>: descend one level
    if (groups.length === 1) {
      const inner = Array.from(groups[0].children).filter(el => el.tagName === 'g');
      if (inner.length > 1) groups = inner;
    }

    // Strategy 4 — no groups at all: treat all shapes in SVG as one section
    if (!groups.length) {
      const shapes = Array.from(srcSvg.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon'));
      if (shapes.length) {
        // Synthesize a single virtual group containing all shapes
        const name = srcSvg.getAttribute('id') || srcSvg.getAttribute('data-name') || 'Layer 1';
        // Create a synthetic result directly without using group structure
        const pathData = shapes.map(el => this._shapeToD(el)).filter(Boolean).join(' ');
        let svgLength = 0;
        if (pathData) {
          const tempSvg2 = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          tempSvg2.style.cssText = 'position:absolute;left:-9999px;visibility:hidden';
          const vb = srcSvg.getAttribute('viewBox');
          if (vb) tempSvg2.setAttribute('viewBox', vb);
          document.body.appendChild(tempSvg2);
          const tp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          tp.setAttribute('d', pathData);
          tempSvg2.appendChild(tp);
          svgLength = tp.getTotalLength();
          document.body.removeChild(tempSvg2);
        }
        return [{ layerId: 'all-shapes', name, pathData, svgLength }];
      }
    }

    if (!groups.length) return [];

    // Mount a temporary invisible SVG to measure path lengths accurately
    const tempSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    tempSvg.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;pointer-events:none';
    const vb = srcSvg.getAttribute('viewBox');
    if (vb) tempSvg.setAttribute('viewBox', vb);
    document.body.appendChild(tempSvg);

    const SHAPE_SELECTOR = 'path, rect, circle, ellipse, line, polyline, polygon';

    const results = groups.map((g, i) => {
      const shapes   = Array.from(g.querySelectorAll(SHAPE_SELECTOR));
      const pathData = shapes.map(el => this._shapeToD(el)).filter(Boolean).join(' ');

      let svgLength = 0;
      if (pathData) {
        const tempPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        tempPath.setAttribute('d', pathData);
        tempSvg.appendChild(tempPath);
        svgLength = tempPath.getTotalLength();
        tempSvg.removeChild(tempPath);
      }

      // Resolve display name — Illustrator CC (data-name), Inkscape (inkscape:label), id
      const name = g.getAttribute('data-name')
        || g.getAttribute('inkscape:label')
        || g.id
        || `Layer ${i + 1}`;

      const layerId = g.id || `layer-${i}`;

      // Measure each individually-selectable sub-path.
      // Illustrator compound paths pack multiple strokes into one <path d="M...M...M...">.
      // We split each <path> at M boundaries so every concentric line is selectable.
      let spIdx = 0;
      const subPaths = shapes.flatMap((el) => {
        const pd = this._shapeToD(el);
        if (!pd) return [];
        const segments = this._splitCompoundPath(pd);
        return segments.map(seg => {
          const id = `${layerId}-p${spIdx++}`;
          const tp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          tp.setAttribute('d', seg);
          tempSvg.appendChild(tp);
          const len = tp.getTotalLength();
          tempSvg.removeChild(tp);
          return { pathId: id, name: `Path ${spIdx}`, pathData: seg, svgLength: len };
        });
      });

      return { layerId, name, pathData, svgLength, subPaths };
    });

    document.body.removeChild(tempSvg);
    return results;
  }

  /**
   * For each artwork layer with pathData, place a wide invisible hit path in
   * #layer-hits so the layer is clickable regardless of original stroke width.
   */
  setLayerHitPaths(layers) {
    const hitsLayer = this.svg.querySelector('#layer-hits');
    if (!hitsLayer) return;
    hitsLayer.innerHTML = '';
    const ns = 'http://www.w3.org/2000/svg';

    const SHAPE_SELECTOR = 'path, rect, circle, ellipse, line, polyline, polygon';

    layers.forEach(layer => {
      if (!layer.pathData?.trim()) return;

      const subPaths = layer.subPaths || [];
      const hasMultiple = subPaths.length > 1;

      // When multiple paths exist, create one hit area per sub-path so each is individually selectable.
      // When only one path (or no subPaths data), use the whole-layer hit path as before.
      const targets = hasMultiple
        ? subPaths
        : [{ pathData: layer.pathData, pathId: layer.layerId, _wholeLayer: true }];

      targets.forEach((target) => {
        if (!target.pathData?.trim()) return;

        const hit = document.createElementNS(ns, 'path');
        hit.setAttribute('d',              target.pathData);
        hit.setAttribute('stroke',         '#fff');
        hit.setAttribute('stroke-opacity', '0');
        hit.setAttribute('stroke-width',   '20');
        hit.setAttribute('fill',           'none');
        hit.setAttribute('stroke-linecap', 'round');
        hit.setAttribute('pointer-events', 'stroke');
        hit.style.cursor = 'pointer';

        hit.addEventListener('mouseenter', () => {
          // Don't override dim when paths are selected
          if (this._selPaths.length > 0) return;
          const importedSvg = this.svg.querySelector('#imported-svg');
          if (!importedSvg) return;
          importedSvg.style.opacity = '1';
          const layerGroup = importedSvg.querySelector(`#${CSS.escape(layer.layerId)}`);
          if (hasMultiple && layerGroup) {
            const pathIdx = subPaths.indexOf(target);
            Array.from(layerGroup.querySelectorAll(SHAPE_SELECTOR)).forEach((el, k) => {
              el.style.opacity = k === pathIdx ? '1' : '0.22';
            });
            Array.from(importedSvg.children).forEach(c => {
              c.style.opacity = c === layerGroup ? '1' : '0.22';
            });
          } else {
            Array.from(importedSvg.children).forEach(c => {
              c.style.opacity = c.id === layer.layerId ? '1' : '0.22';
            });
          }
        });

        hit.addEventListener('mouseleave', () => {
          if (this._selPaths.length > 0) return;
          const importedSvg = this.svg.querySelector('#imported-svg');
          if (!importedSvg) return;
          importedSvg.style.opacity = String(this._artworkOpacity);
          const layerGroup = importedSvg.querySelector(`#${CSS.escape(layer.layerId)}`);
          if (layerGroup) {
            layerGroup.querySelectorAll(SHAPE_SELECTOR).forEach(el => { el.style.opacity = ''; });
          }
          Array.from(importedSvg.children).forEach(c => { c.style.opacity = ''; });
        });

        hit.addEventListener('click', e => {
          e.stopPropagation();
          if (hasMultiple) {
            this.selectPath(layer, target, e.shiftKey);
          } else {
            this.clearPathSelection();
            this.onLayerClick?.(layer.layerId);
          }
        });

        hitsLayer.appendChild(hit);
      });
    });
  }

  _updateStripArrow(id) {
    const entry = this._strips.get(id);
    if (!entry) return;
    entry.arrowEl?.remove();
    entry.startDotEl?.remove();
    entry.arrowEl = null;
    entry.startDotEl = null;

    const { pathEl, data, g } = entry;
    const ns  = 'http://www.w3.org/2000/svg';
    let len;
    try { len = pathEl.getTotalLength(); } catch { return; }
    if (!len || len < 8) return;

    const reversed = data.reversed ?? false;

    // Arrow position: 35% from head (or 65% if reversed so it shows reversed direction)
    const arrowT  = reversed ? 0.65 : 0.35;
    const dT      = 0.025;
    const ptA     = pathEl.getPointAtLength((arrowT - (reversed ? dT : -dT)) * len);
    const ptB     = pathEl.getPointAtLength((arrowT + (reversed ? dT : -dT)) * len);
    const dx = ptB.x - ptA.x, dy = ptB.y - ptA.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / dist, uy = dy / dist;
    const mid = pathEl.getPointAtLength(arrowT * len);
    const sz = 5;

    const tip   = `${mid.x + ux * sz},${mid.y + uy * sz}`;
    const left  = `${mid.x - ux * sz * 0.5 + uy * sz * 0.9},${mid.y - uy * sz * 0.5 - ux * sz * 0.9}`;
    const right = `${mid.x - ux * sz * 0.5 - uy * sz * 0.9},${mid.y - uy * sz * 0.5 + ux * sz * 0.9}`;

    const arrow = document.createElementNS(ns, 'polygon');
    arrow.setAttribute('points', `${tip} ${left} ${right}`);
    arrow.setAttribute('fill', data.color);
    arrow.setAttribute('opacity', '0.75');
    arrow.setAttribute('pointer-events', 'none');
    g.appendChild(arrow);

    // Start dot at index 0 (geometric start if normal, geometric end if reversed)
    const startLen = reversed ? len : 0;
    const sp = pathEl.getPointAtLength(startLen);
    const startDot = this._makeCircle(sp.x, sp.y, 4, '#06d6a0');
    startDot.setAttribute('opacity', '0.9');
    startDot.setAttribute('pointer-events', 'none');
    g.appendChild(startDot);

    entry.arrowEl    = arrow;
    entry.startDotEl = startDot;
  }

  refreshStripArrow(id) { this._updateStripArrow(id); }

  /** Redraw the emit-direction fan arc overlay on a strip. Call after emitAngle changes. */
  refreshEmitDirection(id) {
    const entry = this._strips.get(id);
    if (!entry) return;
    entry.emitArcEl?.remove();
    entry.emitArcEl = null;

    const { pathEl, data, g } = entry;
    const angle = data.emitAngle;
    if (angle == null) return;

    const ns = 'http://www.w3.org/2000/svg';
    let len;
    try { len = pathEl.getTotalLength(); } catch { return; }
    if (!len) return;

    const mid     = pathEl.getPointAtLength(len * 0.5);
    const emitRad = (angle - 90) * Math.PI / 180;
    const spread  = Math.PI / 3;
    const r       = Math.min(Math.max(len * 0.12, 10), 30);

    const startA = emitRad - spread;
    const endA   = emitRad + spread;
    const x0 = mid.x + Math.cos(startA) * r;
    const y0 = mid.y + Math.sin(startA) * r;
    const x1 = mid.x + Math.cos(endA)   * r;
    const y1 = mid.y + Math.sin(endA)   * r;

    const arc = document.createElementNS(ns, 'path');
    arc.setAttribute('d', `M ${mid.x.toFixed(1)},${mid.y.toFixed(1)} L ${x0.toFixed(1)},${y0.toFixed(1)} A ${r.toFixed(1)},${r.toFixed(1)} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z`);
    arc.setAttribute('fill', data.color);
    arc.setAttribute('fill-opacity', '0.18');
    arc.setAttribute('stroke', data.color);
    arc.setAttribute('stroke-width', '1');
    arc.setAttribute('stroke-opacity', '0.5');
    arc.setAttribute('pointer-events', 'none');

    const ax = mid.x + Math.cos(emitRad) * (r * 0.82);
    const ay = mid.y + Math.sin(emitRad) * (r * 0.82);
    const arrow = document.createElementNS(ns, 'line');
    arrow.setAttribute('x1', mid.x.toFixed(1)); arrow.setAttribute('y1', mid.y.toFixed(1));
    arrow.setAttribute('x2', ax.toFixed(1));    arrow.setAttribute('y2', ay.toFixed(1));
    arrow.setAttribute('stroke', data.color);
    arrow.setAttribute('stroke-width', '1.5');
    arrow.setAttribute('stroke-opacity', '0.8');
    arrow.setAttribute('stroke-linecap', 'round');
    arrow.setAttribute('pointer-events', 'none');

    const gr = document.createElementNS(ns, 'g');
    gr.setAttribute('pointer-events', 'none');
    gr.appendChild(arc);
    gr.appendChild(arrow);
    g.appendChild(gr);
    entry.emitArcEl = gr;
  }

  clearStripsOnly() {
    this._strips.forEach(entry => entry.g.remove());
    this._strips.clear();
    this.selectedId = null;
    this._cancelDraw();
    this.clearLayerHighlight();
    this._clearSelectionOverlay();
  }

  clearCanvas() {
    this.clearStripsOnly();
    this.svg.querySelector('#imported-svg').innerHTML      = '';
    this.svg.querySelector('#layer-hits').innerHTML        = '';
    this.svg.querySelector('#selection-overlay').innerHTML = '';
    this.svg.querySelector('#imported-defs')?.remove();
    this._sourceViewBox = null;
    this._paletteIdx = 0;
    this._setViewBox(); // restore canvas-sized viewBox
  }
}
