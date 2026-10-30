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
  const $ = (id) => document.getElementById(id);

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

  const _ptA = { x: 0, y: 0 };
  const _ptB = { x: 0, y: 0 };
  const _ptC = { x: 0, y: 0 };

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

  function projectToScreen(wx, wy, out) {
    const { a, b, tx, ty } = camera;
    out.x = wx * a - wy * b + tx;
    out.y = wx * b + wy * a + ty;
  }

  const currentRect = () => liveCanvas.getBoundingClientRect();

  function localPoint(touch, rect) {
    return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
  }

  function beginPendingPan(touch, rect) {
    return { type: "pending_pan", startX: touch.clientX - rect.left, startY: touch.clientY - rect.top };
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

  function applyPenStyle(ctx, stroke) {
    const color = stroke.isEraser ? "#fbfaf7" : (stroke.color || "#1a1a2e");
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = (stroke.width || 4) * camera.scale;
  }

  function pushPoint(x, y) {
    if (screenCount >= MAX_POINTS) return false;
    screenX[screenCount] = x;
    screenY[screenCount] = y;
    screenCount++;
    return true;
  }

  function resizeLayer(canvas, context, w, h, factor) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * factor * dpr;
    canvas.height = h * factor * dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function strokeBounds(stroke) {
    if (!stroke || !stroke.points || stroke.points.length === 0) return null;
    const b = emptyBounds();
    for (const p of stroke.points) extendBounds(b, p.x, p.y);
    return b;
  }

  function updateIndicators() {
    const { scale, rotation } = camera;
    if (zoomEl) zoomEl.textContent = scale >= 0.01 ? Math.round(scale * 100) + "%" : scale.toExponential(1);
    if (rotEl) rotEl.textContent = Math.round(rotation * 180 / Math.PI) + "°";
  }

  // --- EXTRACTED HELPERS ---
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

  function snapRotationIfClose() {
    if (!toolbar.rotationLocked && Math.abs(camera.rotation) < 5 * Math.PI / 180) {
      camera.rotation = 0;
      toolbar.rotationSnapHoldUntil = Date.now() + 1000;
      camera.markDirty();
      updateIndicators();
      panBuffer.reset();
      renderBackground();
      return true;
    }
    return false;
  }

  class QuadTree {
    // 1. DEFAULT PARAMETERS (No more || 10, || 4)
    constructor(bounds, maxObjects = 10, maxLevels = 4, level = 0) {
      this.bounds = bounds; this.maxObjects = maxObjects; this.maxLevels = maxLevels; this.level = level;
      this.objects = []; this.nodes = [];
    }
    split() {
      const lvl = this.level + 1;
      const w = this.bounds.w / 2, h = this.bounds.h / 2;
      const x = this.bounds.x, y = this.bounds.y;
      // 2. DATA TABLE FOR QUADRANT OFFSETS
      const offsets = [[w, 0], [0, 0], [0, h], [w, h]];
      this.nodes = offsets.map(([dx, dy]) =>
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

  function drawGrid(c, w, h, cx, cy) {
    const spacing = getGridSpacing(); // EXTRACTED
    const bounds = camera.getVisibleBounds(w, h, cx, cy);
    const startX = Math.floor(bounds.minX / spacing) * spacing;
    const startY = Math.floor(bounds.minY / spacing) * spacing;

    c.fillStyle = "#d0d0d8";
    for (let wx = startX; wx <= bounds.maxX; wx += spacing) {
      for (let wy = startY; wy <= bounds.maxY; wy += spacing) {
        projectToScreen(wx, wy, _ptA);
        c.beginPath(); c.arc(_ptA.x, _ptA.y, 1.5, 0, Math.PI * 2); c.fill();
      }
    }
  }

  function drawStrokeOn(c, stroke) {
    if (!stroke.points || stroke.points.length === 0) return;
    if ((stroke.width || 4) * camera.scale < 0.1) return;

    applyPenStyle(c, stroke);
    const pts = stroke.points;

    if (pts.length === 1) {
      projectToScreen(pts[0].x, pts[0].y, _ptA);
      c.beginPath(); c.arc(_ptA.x, _ptA.y, c.lineWidth / 2, 0, Math.PI * 2); c.fill();
      return;
    }

    projectToScreen(pts[0].x, pts[0].y, _ptA);
    c.beginPath();
    c.moveTo(_ptA.x, _ptA.y);

    for (let i = 1; i < pts.length - 1; i++) {
      projectToScreen(pts[i].x, pts[i].y, _ptB);
      projectToScreen(pts[i + 1].x, pts[i + 1].y, _ptC);
      c.quadraticCurveTo(_ptB.x, _ptB.y, (_ptB.x + _ptC.x) / 2, (_ptB.y + _ptC.y) / 2);
    }

    projectToScreen(pts[pts.length - 1].x, pts[pts.length - 1].y, _ptA);
    c.lineTo(_ptA.x, _ptA.y);
    c.stroke();
  }

  function renderBackground() {
    const w = bgCanvas.width / (window.devicePixelRatio || 1);
    const h = bgCanvas.height / (window.devicePixelRatio || 1);
    const cx = w / 2, cy = h / 2;

    camera.updateMatrix(cx, cy);
    bgCtx.clearRect(0, 0, w, h);
    drawGrid(bgCtx, w, h, cx, cy);

    if (canvasData) {
      const view = camera.getVisibleBounds(w, h, cx, cy);
      const visible = strokeTree ? strokeTree.retrieve(view) : canvasData.strokes;
      for (const s of visible) drawStrokeOn(bgCtx, s);
    }
  }

  let renderScheduled = false;
  function redrawLive() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      liveCtx.clearRect(0, 0, liveCanvas.clientWidth, liveCanvas.clientHeight);
      if (!currentStroke || screenCount === 0) return;

      applyPenStyle(liveCtx, currentStroke);
      liveCtx.beginPath();
      for (let i = 0; i < screenCount; i++) {
        if (i === 0) liveCtx.moveTo(screenX[i], screenY[i]);
        else liveCtx.lineTo(screenX[i], screenY[i]);
      }
      liveCtx.stroke();
    });
  }

  function penDown(e) {
    if (!isPen(e)) return;
    e.preventDefault();
    isPenActive = true;
    if (toolbarEl) toolbarEl.style.pointerEvents = "none";

    const p = localPoint(e, currentRect());
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
    if (!isPen(e) || !currentStroke || screenCount >= MAX_POINTS) return;

    const p = localPoint(e, currentRect());
    const dx = p.x - screenX[screenCount - 1];
    const dy = p.y - screenY[screenCount - 1];
    if (dx * dx + dy * dy < 2.25) return;

    pushPoint(p.x, p.y);
    redrawLive();
  }

  function penUp(e) {
    if (!isPen(e)) return;
    isPenActive = false;
    if (toolbarEl) toolbarEl.style.pointerEvents = "auto";

    if (currentStroke && screenCount > 0) {
      // EXTRACTED
      convertScreenPointsToWorld(currentStroke, strokeOriginCamera);

      if (canvasData) {
        currentStroke.bounds = strokeBounds(currentStroke);
        canvasData.strokes.push(currentStroke);
        if (strokeTree) strokeTree.insert(currentStroke);
        autosaver.schedule(canvasData);
      }
      currentStroke = null;
      renderBackground();
      redrawLive();
    }
  }

  const touchCtx = { gesture: null };

  function touchStart(e) {
    if (isPenActive) return;
    const rect = currentRect();

    if (e.touches.length === 1) {
      touchCtx.gesture = beginPendingPan(e.touches[0], rect);
    } else if (e.touches.length === 2) {
      const a = analyzeTwoTouches(e.touches[0], e.touches[1], rect);
      touchCtx.gesture = {
        type: "pinch",
        startDist: a.dist, startAngle: a.angle,
        startScale: camera.scale, startRotation: camera.rotation,
        startMid: { x: a.midX, y: a.midY }
      };
    }
  }

  function touchMove(e) {
    if (isPenActive || !touchCtx.gesture) return;
    e.preventDefault();
    const rect = currentRect();

    if (touchCtx.gesture.type === "pending_pan" && e.touches.length === 1) {
      const p = localPoint(e.touches[0], rect);
      if ((p.x - touchCtx.gesture.startX) ** 2 + (p.y - touchCtx.gesture.startY) ** 2 > 225) {
        touchCtx.gesture = { type: "pan", lastX: p.x, lastY: p.y };
      }
    } else if (touchCtx.gesture.type === "pan" && e.touches.length === 1) {
      const p = localPoint(e.touches[0], rect);
      const dx = p.x - touchCtx.gesture.lastX;
      const dy = p.y - touchCtx.gesture.lastY;

      if (panBuffer.addDelta(dx, dy, liveCanvas.clientWidth, liveCanvas.clientHeight)) {
        panBuffer.reset();
        renderBackground();
      }

      camera.pan(dx, dy);
      touchCtx.gesture.lastX = p.x;
      touchCtx.gesture.lastY = p.y;
    } else if (touchCtx.gesture.type === "pinch" && e.touches.length >= 2) {
      panBuffer.reset();
      const a = analyzeTwoTouches(e.touches[0], e.touches[1], rect);

      const g = touchCtx.gesture;
      const newScale = toolbar.zoomLocked ? g.startScale : CLAMP_SCALE(g.startScale * (a.dist / g.startDist));
      const newRot = (!toolbar.rotationLocked && Date.now() >= toolbar.rotationSnapHoldUntil)
        ? g.startRotation + (a.angle - g.startAngle)
        : g.startRotation;

      camera.zoomAt(a.midX, a.midY, newScale, newRot, halfW, halfH);
      updateIndicators();
      renderBackground();
    }
  }

  function touchEnd(e) {
    if (isPenActive || !touchCtx.gesture) return;

    if (e.touches.length === 0) {
      // EXTRACTED SNAP LOGIC
      if (touchCtx.gesture.type === "pinch") {
        snapRotationIfClose();
      }
      touchCtx.gesture = null;
    } else if (e.touches.length === 1 && touchCtx.gesture.type === "pinch") {
      touchCtx.gesture = beginPendingPan(e.touches[0], currentRect());
    }
  }

  function init() {
    ([bgCanvas, liveCanvas, toolbarEl, zoomEl, rotEl, backBtn] =
      ["bg-surface", "draw-surface", "toolbar", "zoom-indicator", "rotation-indicator", "back-btn"].map($));

    if (!bgCanvas || !liveCanvas || !toolbarEl) {
      return window.showError("HTML elements are missing. Did you update canvas.html?", "red");
    }

    bgCtx = bgCanvas.getContext("2d");
    liveCtx = liveCanvas.getContext("2d");

    function resize() {
      const w = liveCanvas.clientWidth, h = liveCanvas.clientHeight;
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
      strokeTree = new QuadTree({ x: -S/2, y: -S/2, w: S, h: S }); // defaults applied here
      for (const s of canvasData.strokes) if (s.points.length > 0 && s.bounds) strokeTree.insert(s);
      $("canvas-title").textContent = data.title || "Untitled";
      centerOnContent();
      updateIndicators();
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

    if (panBuffer) panBuffer.reset();
    renderBackground();
    updateIndicators();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
