(function () {
  "use strict";

  const deps = ["Store", "Camera", "PanBuffer", "Toolbar", "AutoSaver"];
  const missingDep = deps.find(name => !window[name]);
  if (missingDep) return window.showError(missingDep.toLowerCase() + ".js is missing.", "orange");

  const Store = window.Store;
  const camera = new window.Camera();
  const toolbar = new window.Toolbar();
  const autosaver = new window.AutoSaver(Store, 5000);

  const MIN_SCALE = 0.000000001;
  const MAX_SCALE = 1000000000;
  const CLAMP_SCALE = (v) => v < MIN_SCALE ? MIN_SCALE : v > MAX_SCALE ? MAX_SCALE : v;
  const isPen = (e) => e.pointerType === "pen" || e.pointerType === "mouse";
  const hasPoints = (s) => s && s.points && s.points.length > 0;
  const $ = (id) => document.getElementById(id);
  const snap = (val, spacing) => Math.floor(val / spacing) * spacing;
  const DPR = () => window.devicePixelRatio || 1;
  const strokeScreenWidth = (stroke) => (stroke.width || 4) * camera.scale;

  let bgCanvas, bgCtx, liveCanvas, liveCtx, toolbarEl, zoomEl, rotEl, backBtn;

  let panBuffer = null;
  let canvasData = null;
  let currentStroke = null;
  let isPenActive = false;
  let strokeOriginCamera = null;

  const MAX_POINTS = 50000;
  const screenX = new Float32Array(MAX_POINTS);
  const screenY = new Float32Array(MAX_POINTS);
  let screenCount = 0;

  let halfW = 0;
  let halfH = 0;

  function emptyBounds() { return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }; }
  function extendBounds(b, x, y) {
    b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x);
    b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y);
  }
  function mergeBounds(a, b) {
    if (!b) return a;
    a.minX = Math.min(a.minX, b.minX); a.maxX = Math.max(a.maxX, b.maxX);
    a.minY = Math.min(a.minY, b.minY); a.maxY = Math.max(a.maxY, b.maxY);
    return a;
  }

  const currentRect = () => liveCanvas.getBoundingClientRect();
  const liveSize = () => ({ w: liveCanvas.clientWidth, h: liveCanvas.clientHeight });
  const bgSize = () => ({ w: bgCanvas.width / DPR(), h: bgCanvas.height / DPR() });

  function localPoint(touch, rect) {
    return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
  }

  function firstTouch(e, rect) {
    return localPoint(e.touches[0], rect);
  }

  function getPenPoint(e) {
    return isPen(e) ? localPoint(e, currentRect()) : null;
  }

  function analyzeTwoTouches(t0, t1, rect) {
    const p0 = localPoint(t0, rect);
    const p1 = localPoint(t1, rect);
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    return {
      dist: Math.sqrt(dx * dx + dy * dy) || 1,
      angle: Math.atan2(dy, dx),
      midX: (p0.x + p1.x) / 2,
      midY: (p0.y + p1.y) / 2
    };
  }

  function applyPenStyle(ctx, stroke, screenWidth) {
    const color = stroke.isEraser ? "#fbfaf7" : (stroke.color || "#1a1a2e");
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = screenWidth;
  }

  function pushPoint(x, y) {
    if (screenCount >= MAX_POINTS) return false;
    screenX[screenCount] = x;
    screenY[screenCount] = y;
    screenCount++;
    return true;
  }

  function resizeLayer(canvas, context, w, h, factor) {
    const dpr = DPR();
    canvas.width = w * factor * dpr;
    canvas.height = h * factor * dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function strokeBounds(stroke) {
    if (!hasPoints(stroke)) return null;
    const b = emptyBounds();
    for (const p of stroke.points) extendBounds(b, p.x, p.y);
    return b;
  }

  function updateIndicators() {
    const { scale, rotation } = camera;
    if (zoomEl) zoomEl.textContent = scale >= 0.01 ? Math.round(scale * 100) + "%" : scale.toExponential(1);
    if (rotEl) rotEl.textContent = Math.round(rotation * 180 / Math.PI) + "°";
  }

  function getGridSpacing() {
    let spacing = 100;
    while (spacing * camera.scale < 30) spacing *= 2;
    while (spacing * camera.scale > 60) spacing /= 2;
    return spacing;
  }

  function convertScreenPointsToWorld(stroke, camSnapshot) {
    const cos = Math.cos(-camSnapshot.rotation);
    const sin = Math.sin(-camSnapshot.rotation);
    for (let i = 0; i < screenCount; i++) {
      const px = screenX[i] - halfW;
      const py = screenY[i] - halfH;
      stroke.points.push({
        x: (px * cos - py * sin) / camSnapshot.scale + camSnapshot.x,
        y: (px * sin + py * cos) / camSnapshot.scale + camSnapshot.y
      });
    }
  }

  function togglePenMode(active) {
    isPenActive = active;
    if (toolbarEl) toolbarEl.style.pointerEvents = active ? "none" : "auto";
  }

  function refreshUI() {
    if (panBuffer) panBuffer.reset();
    renderBackground();
    updateIndicators();
  }

  function saveStroke(stroke) {
    if (!canvasData) return;
    stroke.bounds = strokeBounds(stroke);
    canvasData.strokes.push(stroke);
    if (strokeTree) strokeTree.insert(stroke);
    autosaver.schedule(canvasData);
  }

  function flushPanBuffer(dx, dy) {
    if (panBuffer.addDelta(dx, dy, liveCanvas.clientWidth, liveCanvas.clientHeight)) {
      panBuffer.reset();
      renderBackground();
    }
  }

  function continueAsPendingPanIfOneTouch(e) {
    if (e.touches.length !== 1) return null;
    return Gesture.pending_pan.start(firstTouch(e, currentRect()));
  }

  const Gesture = {
    pending_pan: {
      start(p) { return { type: "pending_pan", startX: p.x, startY: p.y }; },
      move(g, e, rect) {
        const p = firstTouch(e, rect);
        if ((p.x - g.startX) ** 2 + (p.y - g.startY) ** 2 > 225) return Gesture.pan.start(p);
        return g;
      },
      end() { return null; }
    },
    pan: {
      start(p) { return { type: "pan", lastX: p.x, lastY: p.y }; },
      move(g, e, rect) {
        const p = firstTouch(e, rect);
        const dx = p.x - g.lastX;
        const dy = p.y - g.lastY;
        flushPanBuffer(dx, dy);
        camera.pan(dx, dy);
        return Gesture.pan.start(p);
      },
      end(g, e) { return continueAsPendingPanIfOneTouch(e); }
    },
    pinch: {
      start(t0, t1, rect) {
        const a = analyzeTwoTouches(t0, t1, rect);
        return {
          type: "pinch",
          startDist: a.dist, startAngle: a.angle,
          startScale: camera.scale, startRotation: camera.rotation,
          startMid: { x: a.midX, y: a.midY }
        };
      },
      move(g, e, rect) {
        panBuffer.reset();
        const a = analyzeTwoTouches(e.touches[0], e.touches[1], rect);
        const newScale = toolbar.zoomLocked ? g.startScale : CLAMP_SCALE(g.startScale * (a.dist / g.startDist));
        const newRot = (!toolbar.rotationLocked && Date.now() >= toolbar.rotationSnapHoldUntil)
          ? g.startRotation + (a.angle - g.startAngle)
          : g.startRotation;
        camera.zoomAt(a.midX, a.midY, newScale, newRot, halfW, halfH);
        updateIndicators();
        renderBackground();
        return g;
      },
      end(g, e) {
        if (!toolbar.rotationLocked && Math.abs(camera.rotation) < 5 * Math.PI / 180) {
          camera.rotation = 0;
          toolbar.rotationSnapHoldUntil = Date.now() + 1000;
          camera.markDirty();
          refreshUI();
        }
        return continueAsPendingPanIfOneTouch(e);
      }
    }
  };

  class QuadTree {
    constructor(bounds, maxObjects = 10, maxLevels = 4, level = 0) {
      this.bounds = bounds; this.maxObjects = maxObjects; this.maxLevels = maxLevels; this.level = level;
      this.objects = []; this.nodes = [];
    }
    split() {
      const lvl = this.level + 1;
      const w = this.bounds.w / 2, h = this.bounds.h / 2;
      const x = this.bounds.x, y = this.bounds.y;
      this.nodes = [[w, 0], [0, 0], [0, h], [w, h]].map(([dx, dy]) =>
        new QuadTree({ x: x + dx, y: y + dy, w, h }, this.maxObjects, this.maxLevels, lvl)
      );
    }
    getIndex(box) {
      const midX = this.bounds.x + this.bounds.w / 2;
      const midY = this.bounds.y + this.bounds.h / 2;
      const top = box.minY < midY && box.maxY < midY;
      const bottom = box.minY > midY;
      if (box.minX < midX && box.maxX < midX) return top ? 1 : bottom ? 2 : -1;
      if (box.minX > midX) return top ? 0 : bottom ? 3 : -1;
      return -1;
    }
    insert(item) {
      if (this.nodes.length) {
        const idx = this.getIndex(item.bounds);
        if (idx !== -1) return this.nodes[idx].insert(item);
      }
      this.objects.push(item);
      if (this.objects.length > this.maxObjects && this.level < this.maxLevels) {
        if (!this.nodes.length) this.split();
        let i = 0;
        while (i < this.objects.length) {
          const idx = this.getIndex(this.objects[i].bounds);
          if (idx !== -1) this.nodes[idx].insert(this.objects.splice(i, 1)[0]);
          else i++;
        }
      }
    }
    retrieve(box) {
      let out = this.objects;
      if (this.nodes.length) {
        const idx = this.getIndex(box);
        if (idx !== -1) out = out.concat(this.nodes[idx].retrieve(box));
        else for (let i = 0; i < this.nodes.length; i++) out = out.concat(this.nodes[i].retrieve(box));
      }
      return out;
    }
  }
  let strokeTree = null;

  // --- RENDERING (MATH-OPTIMIZED) ---

  // Grid: 1 beginPath, N arcs, 1 fill. Camera matrix hoisted to locals.
  // wx*a hoisted out of the inner loop (invariant).
  function drawGrid(c, bounds) {
    const spacing = getGridSpacing();
    const { a, b, tx, ty } = camera;
    const startX = snap(bounds.minX, spacing);
    const startY = snap(bounds.minY, spacing);

    c.fillStyle = "#d0d0d8";
    c.beginPath();
    for (let wx = startX; wx <= bounds.maxX; wx += spacing) {
      const wxA = wx * a;
      const wxB = wx * b;
      for (let wy = startY; wy <= bounds.maxY; wy += spacing) {
        c.arc(wxA - wy * b + tx, wxB + wy * a + ty, 1.5, 0, Math.PI * 2);
      }
    }
    c.fill();
  }

  // Stroke: N screen conversions instead of 2N-2. Camera matrix hoisted.
  function drawStrokeOn(c, stroke) {
    if (!hasPoints(stroke)) return;
    const screenWidth = (stroke.width || 4) * camera.scale;
    if (screenWidth < 0.1) return;

    applyPenStyle(c, stroke, screenWidth);
    const pts = stroke.points;
    const { a, b, tx, ty } = camera;

    let prevX = pts[0].x * a - pts[0].y * b + tx;
    let prevY = pts[0].x * b + pts[0].y * a + ty;

    if (pts.length === 1) {
      c.beginPath();
      c.arc(prevX, prevY, screenWidth / 2, 0, Math.PI * 2);
      c.fill();
      return;
    }

    c.beginPath();
    c.moveTo(prevX, prevY);

    let curX = pts[1].x * a - pts[1].y * b + tx;
    let curY = pts[1].x * b + pts[1].y * a + ty;

    for (let i = 1; i < pts.length - 1; i++) {
      const nextX = pts[i + 1].x * a - pts[i + 1].y * b + tx;
      const nextY = pts[i + 1].x * b + pts[i + 1].y * a + ty;
      c.quadraticCurveTo(curX, curY, (curX + nextX) / 2, (curY + nextY) / 2);
      curX = nextX;
      curY = nextY;
    }

    c.lineTo(curX, curY);
    c.stroke();
  }

  function renderBackground() {
    const { w, h } = bgSize();
    const cx = w / 2, cy = h / 2;
    camera.updateMatrix(cx, cy);
    const bounds = camera.getVisibleBounds(w, h, cx, cy);

    bgCtx.clearRect(0, 0, w, h);
    drawGrid(bgCtx, bounds);

    if (canvasData) {
      const visible = strokeTree ? strokeTree.retrieve(bounds) : canvasData.strokes;
      for (const s of visible) drawStrokeOn(bgCtx, s);
    }
  }

  let renderScheduled = false;
  function redrawLive() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      const { w, h } = liveSize();
      liveCtx.clearRect(0, 0, w, h);
      if (!currentStroke || screenCount === 0) return;

      applyPenStyle(liveCtx, currentStroke, strokeScreenWidth(currentStroke));
      liveCtx.beginPath();
      for (let i = 0; i < screenCount; i++) {
        if (i === 0) liveCtx.moveTo(screenX[i], screenY[i]);
        else liveCtx.lineTo(screenX[i], screenY[i]);
      }
      liveCtx.stroke();
    });
  }

  function penDown(e) {
    const p = getPenPoint(e);
    if (!p) return;

    e.preventDefault();
    togglePenMode(true);

    strokeOriginCamera = { x: camera.x, y: camera.y, scale: camera.scale, rotation: camera.rotation };
    currentStroke = {
      id: Store.uuid(), points: [], color: toolbar.currentColor,
      width: toolbar.currentSize / camera.scale, isEraser: toolbar.currentTool === "eraser", originScale: camera.scale
    };
    screenCount = 0;
    pushPoint(p.x, p.y);
    redrawLive();
  }

  function penMove(e) {
    const p = getPenPoint(e);
    if (!p || !currentStroke || screenCount >= MAX_POINTS) return;

    const dx = p.x - screenX[screenCount - 1];
    const dy = p.y - screenY[screenCount - 1];
    if (dx * dx + dy * dy < 2.25) return;

    pushPoint(p.x, p.y);
    redrawLive();
  }

  function penUp(e) {
    if (!isPen(e)) return;
    togglePenMode(false);

    if (currentStroke && screenCount > 0) {
      convertScreenPointsToWorld(currentStroke, strokeOriginCamera);
      saveStroke(currentStroke);
      currentStroke = null;
      renderBackground();
      redrawLive();
    }
  }

  const touchCtx = { gesture: null };

  function dispatchGesture(phase, e) {
    if (isPenActive || !touchCtx.gesture) return;
    if (phase === "move") e.preventDefault();
    const handler = Gesture[touchCtx.gesture.type];
    if (!handler || !handler[phase]) return;
    touchCtx.gesture = handler[phase](touchCtx.gesture, e, currentRect());
  }

  function touchStart(e) {
    if (isPenActive) return;
    const rect = currentRect();
    if (e.touches.length === 1) {
      touchCtx.gesture = Gesture.pending_pan.start(firstTouch(e, rect));
    } else if (e.touches.length === 2) {
      touchCtx.gesture = Gesture.pinch.start(e.touches[0], e.touches[1], rect);
    }
  }

  function touchMove(e) { dispatchGesture("move", e); }
  function touchEnd(e) { dispatchGesture("end", e); }

  function init() {
    ([bgCanvas, liveCanvas, toolbarEl, zoomEl, rotEl, backBtn] =
      ["bg-surface", "draw-surface", "toolbar", "zoom-indicator", "rotation-indicator", "back-btn"].map($));

    if (!bgCanvas || !liveCanvas || !toolbarEl) {
      return window.showError("HTML elements are missing. Did you update canvas.html?", "red");
    }

    bgCtx = bgCanvas.getContext("2d");
    liveCtx = liveCanvas.getContext("2d");

    function resize() {
      const { w, h } = liveSize();
      halfW = w / 2; halfH = h / 2;
      resizeLayer(liveCanvas, liveCtx, w, h, 1.0);
      resizeLayer(bgCanvas, bgCtx, w, h, 1.4);
      panBuffer = new window.PanBuffer(camera, bgCanvas);
      camera.markDirty();
      renderBackground();
    }

    window.addEventListener("resize", resize);
    toolbar.wire(centerOnContent, () => camera.markDirty(), () => {});

    backBtn.addEventListener("click", () => {
      if (autosaver.isSaving || autosaver.pendingData) {
        window.showError("Saving... please wait.", "orange");
        setTimeout(() => { window.location.href = "index.html"; }, 500);
      } else {
        window.location.href = "index.html";
      }
    });

    [
      ["pointerdown", penDown],
      ["pointermove", penMove],
      ["pointerup", penUp],
      ["touchstart", touchStart, { passive: true }],
      ["touchmove", touchMove, { passive: false }],
      ["touchend", touchEnd, { passive: true }]
    ].forEach(([evt, fn, opts]) => liveCanvas.addEventListener(evt, fn, opts));

    const id = new URLSearchParams(window.location.search).get("id");
    if (!id) return window.showError("No canvas ID provided.", "red");

    Store.get(id).then((data) => {
      canvasData = data;
      if (!canvasData.strokes) canvasData.strokes = [];
      const S = 1000000;
      strokeTree = new QuadTree({ x: -S/2, y: -S/2, w: S, h: S });
      for (const s of canvasData.strokes) if (hasPoints(s) && s.bounds) strokeTree.insert(s);
      $("canvas-title").textContent = data.title || "Untitled";
      centerOnContent();
      refreshUI();
      resize();
    }).catch((err) => window.showError("Database error: " + err, "red"));
  }

  function centerOnContent() {
    if (!canvasData || canvasData.strokes.length === 0) return;

    const agg = emptyBounds();
    for (const s of canvasData.strokes) mergeBounds(agg, strokeBounds(s));

    if (!isFinite(agg.minX)) return;
    camera.setPosition(
      (agg.minX + agg.maxX) / 2,
      (agg.minY + agg.maxY) / 2,
      CLAMP_SCALE(Math.min(1000 / (agg.maxX - agg.minX + 400), 800 / (agg.maxY - agg.minY + 400))),
      0
    );

    refreshUI();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
