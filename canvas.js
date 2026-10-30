(function () {
  "use strict";

  const deps = ["Geo", "Store", "Camera", "PanBuffer", "Toolbar", "AutoSaver"];
  const missingDep = deps.find(name => !window[name]);
  if (missingDep) return window.showError(missingDep.toLowerCase() + ".js is missing.", "orange");

  const Store = window.Store;
  const camera = new window.Camera();
  const toolbar = new window.Toolbar();
  const autosaver = new window.AutoSaver(Store, 5000);

  const Geo = window.Geo;

  // ---- tuning numbers: every "magic number" lives here, with a name --------
  const MIN_SCALE = 1e-9;             // furthest zoom-out
  const MAX_SCALE = 1e9;              // furthest zoom-in
  const BG_OVERSCAN = 0.2;            // background canvas extends 20% past each screen edge
  const PAN_START_DIST = 15;          // px a finger must move before it counts as a pan
  const MIN_POINT_DIST = 1.5;         // px the pen must move before a new point is recorded
  const ROT_SNAP_DEG = 5;             // rotation snaps back to 0 when within this many degrees
  const ROT_SNAP_HOLD_MS = 1000;      // ...and stays snapped for this long
  const GRID_BASE = 100;              // grid spacing at 100% zoom (world units)
  const GRID_MIN_PX = 30;             // grid dots are kept between 30px and 60px apart
  const GRID_DOT_RADIUS = 1.5;        // px
  const FIT_PAD = 400;                // world units of breathing room around content on "LOST"
  const FALLBACK_VIEW = { w: 1000, h: 800 }; // used only if the view has no size yet
  const TAU = Math.PI * 2;            // a full circle

  const CLAMP_SCALE = (v) => Geo.clamp(v, MIN_SCALE, MAX_SCALE);
  const isPen = (e) => e.pointerType === "pen" || e.pointerType === "mouse";
  const hasPoints = (s) => s && s.points && s.points.length > 0;
  const $ = (id) => document.getElementById(id);
  const snap = (val, spacing) => Math.floor(val / spacing) * spacing;
  const percent = (v) => (v * 100).toFixed(2) + "%";
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

  // How many points are already painted on the live canvas
  let liveDrawnCount = 0;

  let halfW = 0;
  let halfH = 0;

  // PERF: getBoundingClientRect() forces the browser to recalculate layout. Doing it
  // on every touchmove (right after we changed a CSS transform) is very expensive,
  // so we cache it and only refresh at the start of a gesture / on resize.
  let cachedRect = null;
  const currentRect = () => cachedRect || (cachedRect = liveCanvas.getBoundingClientRect());
  const invalidateRect = () => { cachedRect = null; };
  const liveSize = () => ({ w: liveCanvas.clientWidth, h: liveCanvas.clientHeight });
  const bgSize = () => ({ w: bgCanvas.width / DPR(), h: bgCanvas.height / DPR() });

  function localPoint(touch, rect) {
    return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
  }

  function firstTouch(e, rect) { return localPoint(e.touches[0], rect); }

  function getPenPoint(e) { return isPen(e) ? localPoint(e, currentRect()) : null; }

  function analyzeTwoTouches(t0, t1, rect) {
    const p0 = localPoint(t0, rect);
    const p1 = localPoint(t1, rect);
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    return {
      dist: Math.sqrt(Geo.dist2(dx, dy)) || 1,
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

  const strokeBounds = (stroke) => hasPoints(stroke) ? Geo.boundsOfPoints(stroke.points) : null;

  function updateIndicators() {
    const { scale, rotation } = camera;
    if (zoomEl) zoomEl.textContent = scale >= 0.01 ? Math.round(scale * 100) + "%" : scale.toExponential(1);
    if (rotEl) rotEl.textContent = Math.round(Geo.toDeg(rotation)) + "°";
  }

  const getGridSpacing = () => Geo.gridSpacing(GRID_BASE, camera.scale, GRID_MIN_PX);

  function convertScreenPointsToWorld(stroke, camSnapshot) {
    const cos = Math.cos(-camSnapshot.rotation);
    const sin = Math.sin(-camSnapshot.rotation);
    for (let i = 0; i < screenCount; i++) {
      const px = screenX[i] - halfW;
      const py = screenY[i] - halfH;
      stroke.points.push({
        x: Geo.rotX(px, py, cos, sin) / camSnapshot.scale + camSnapshot.x,
        y: Geo.rotY(px, py, cos, sin) / camSnapshot.scale + camSnapshot.y
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
    stroke._z = canvasData.strokes.length; // draw order, used when sorting visible strokes
    canvasData.strokes.push(stroke);
    if (strokeTree) strokeTree.insert(stroke);
    autosaver.schedule(canvasData);
  }

  function flushPanBuffer(dx, dy) {
    // PERF: use the cached size (halfW/halfH come from resize()) instead of
    // reading clientWidth/clientHeight, which forces a layout on every move.
    if (panBuffer.addDelta(dx, dy, halfW * 2, halfH * 2)) {
      renderBackground(); // renderBackground() also resets the pan buffer offset
    }
  }

  // PERF: touch events can arrive faster than the screen refreshes (especially on
  // 120Hz iPads). Instead of moving the camera on every event, we add the movement
  // up and apply it once per animation frame.
  let pendingPanDx = 0, pendingPanDy = 0, panFrameScheduled = false;

  function applyPendingPan() {
    if (pendingPanDx === 0 && pendingPanDy === 0) return;
    const dx = pendingPanDx, dy = pendingPanDy;
    pendingPanDx = 0; pendingPanDy = 0;
    camera.pan(dx, dy);
    flushPanBuffer(dx, dy);
  }

  function queuePan(dx, dy) {
    pendingPanDx += dx;
    pendingPanDy += dy;
    if (panFrameScheduled) return;
    panFrameScheduled = true;
    requestAnimationFrame(() => {
      panFrameScheduled = false;
      applyPendingPan();
    });
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
        if (Geo.dist2(p.x - g.startX, p.y - g.startY) > PAN_START_DIST ** 2) return Gesture.pan.start(p);
        return g;
      },
      end() { return null; }
    },

    pan: {
      start(p) { return { type: "pan", lastX: p.x, lastY: p.y }; },
      move(g, e, rect) {
        const p = firstTouch(e, rect);
        queuePan(p.x - g.lastX, p.y - g.lastY);
        return Gesture.pan.start(p);
      },
      end(g, e) {
        applyPendingPan(); // don't lose the last bit of movement
        return continueAsPendingPanIfOneTouch(e);
      }
    },

    pinch: {
      start(t0, t1, rect) {
        applyPendingPan(); // finish any queued pan before the camera is snapshotted
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
        if (!toolbar.rotationLocked && Math.abs(camera.rotation) < ROT_SNAP_DEG * Geo.DEG) {
          camera.rotation = 0;
          toolbar.rotationSnapHoldUntil = Date.now() + ROT_SNAP_HOLD_MS;
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

  function drawGrid(c, bounds) {
    const spacing = getGridSpacing();
    const { a, b, tx, ty } = camera;
    const startX = snap(bounds.minX, spacing);
    const startY = snap(bounds.minY, spacing);
    const stepX = -spacing * b;
    const stepY = spacing * a;

    c.fillStyle = "#d0d0d8";
    c.beginPath();

    for (let wx = startX; wx <= bounds.maxX; wx += spacing) {
      let sx = Geo.rotX(wx, startY, a, b) + tx;
      let sy = Geo.rotY(wx, startY, a, b) + ty;

      for (let wy = startY; wy <= bounds.maxY; wy += spacing) {
        // FIX: start each dot as its own sub-path. Without this moveTo, canvas
        // joins consecutive arcs with straight lines and fill() paints grey wedges.
        c.moveTo(sx + GRID_DOT_RADIUS, sy);
        c.arc(sx, sy, GRID_DOT_RADIUS, 0, TAU);
        sx += stepX;
        sy += stepY;
      }
    }

    c.fill();
  }

  function drawStrokeOn(c, stroke) {
    if (!hasPoints(stroke)) return;

    const screenWidth = (stroke.width || 4) * camera.scale;
    if (screenWidth < 0.1) return;

    applyPenStyle(c, stroke, screenWidth);

    const pts = stroke.points;
    const { a, b, tx, ty } = camera;

    let prevX = Geo.rotX(pts[0].x, pts[0].y, a, b) + tx;
    let prevY = Geo.rotY(pts[0].x, pts[0].y, a, b) + ty;

    if (pts.length === 1) {
      c.beginPath();
      c.arc(prevX, prevY, screenWidth / 2, 0, TAU);
      c.fill();
      return;
    }

    c.beginPath();
    c.moveTo(prevX, prevY);

    let curX = Geo.rotX(pts[1].x, pts[1].y, a, b) + tx;
    let curY = Geo.rotY(pts[1].x, pts[1].y, a, b) + ty;

    for (let i = 1; i < pts.length - 1; i++) {
      const nextX = Geo.rotX(pts[i + 1].x, pts[i + 1].y, a, b) + tx;
      const nextY = Geo.rotY(pts[i + 1].x, pts[i + 1].y, a, b) + ty;
      c.quadraticCurveTo(curX, curY, (curX + nextX) / 2, (curY + nextY) / 2);
      curX = nextX;
      curY = nextY;
    }

    c.lineTo(curX, curY);
    c.stroke();
  }

  function renderBackground() {
    // FIX: a freshly drawn background is already at the correct position, so any
    // leftover CSS pan offset must be cleared or the whole drawing appears shifted
    // (e.g. after lifting the pen following a small pan).
    if (panBuffer) panBuffer.reset();

    const { w, h } = bgSize();
    const cx = w / 2, cy = h / 2;

    camera.updateMatrix(cx, cy);

    const bounds = camera.getVisibleBounds(w, h, cx, cy);

    bgCtx.clearRect(0, 0, w, h);
    drawGrid(bgCtx, bounds);

    if (canvasData) {
      // The quad tree only narrows things down roughly: strokes that cross a tree
      // boundary (e.g. anything over the origin) are always returned. So we also do
      // an exact bounding-box test, and skip strokes that are completely off-screen.
      // PERF: this is the biggest saving when re-rendering during a pan.
      let visible = strokeTree ? strokeTree.retrieve(bounds) : canvasData.strokes;
      if (strokeTree) {
        // The tree returns strokes in tree order, not drawing order. Sort back to
        // the order they were drawn in, otherwise erasers can land on the wrong layer.
        visible = visible.slice().sort((p, q) => p._z - q._z);
      }
      for (const s of visible) {
        // skip strokes that are completely off-screen (pad = half the pen width)
        if (s.bounds && !Geo.boundsOverlap(s.bounds, bounds, (s.width || 4) / 2)) continue;
        drawStrokeOn(bgCtx, s);
      }
    }
  }

  // --- INCREMENTAL LIVE DRAW (the ink speed fix) ---
  let liveDrawScheduled = false;

  function scheduleIncrementalLiveDraw() {
    if (liveDrawScheduled) return;
    liveDrawScheduled = true;

    requestAnimationFrame(() => {
      liveDrawScheduled = false;
      if (!currentStroke || liveDrawnCount >= screenCount) return;

      // Draw ONLY the new segment(s). O(new) not O(total stroke).
      liveCtx.beginPath();
      liveCtx.moveTo(screenX[liveDrawnCount - 1], screenY[liveDrawnCount - 1]);
      for (let i = liveDrawnCount; i < screenCount; i++) {
        liveCtx.lineTo(screenX[i], screenY[i]);
      }
      liveCtx.stroke();

      liveDrawnCount = screenCount;
    });
  }

  function clearLive() {
    const { w, h } = liveSize();
    liveCtx.clearRect(0, 0, w, h);
    liveDrawnCount = 0;
  }

  // --- PEN HANDLERS ---
  function penDown(e) {
    invalidateRect();
    applyPendingPan(); // make sure the camera is up to date before we snapshot it
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

    // Clear live canvas, set style once, draw the initial dot synchronously
    clearLive();
    applyPenStyle(liveCtx, currentStroke, strokeScreenWidth(currentStroke));
    liveCtx.beginPath();
    liveCtx.arc(p.x, p.y, liveCtx.lineWidth / 2, 0, TAU);
    liveCtx.fill();
    liveDrawnCount = 1;
  }

  function penMove(e) {
    const p = getPenPoint(e);
    if (!p || !currentStroke || screenCount >= MAX_POINTS) return;

    const dx = p.x - screenX[screenCount - 1];
    const dy = p.y - screenY[screenCount - 1];
    if (Geo.dist2(dx, dy) < MIN_POINT_DIST ** 2) return;

    pushPoint(p.x, p.y);
    scheduleIncrementalLiveDraw();
  }

  function penUp(e) {
    if (!isPen(e)) return;
    togglePenMode(false);

    if (currentStroke && screenCount > 0) {
      const finished = currentStroke;
      currentStroke = null;

      convertScreenPointsToWorld(finished, strokeOriginCamera);
      saveStroke(finished);

      // PERF: paint ONLY the finished stroke onto the background, instead of
      // clearing and redrawing the whole note. The cost no longer grows with how
      // much ink is on the page.
      //
      // This deliberately does NOT call camera.updateMatrix(). camera.a/b/tx/ty
      // still hold the matrix the background bitmap was last drawn with, and the
      // bitmap is currently shown with the pan buffer's CSS offset on top. Drawing
      // with that same matrix puts the stroke exactly where it already appears on
      // screen, so there is no jump, even if you panned a little before drawing.
      // The next full render (pan buffer overflow, zoom, etc.) redraws it from data.
      drawStrokeOn(bgCtx, finished);

      clearLive(); // same frame as the line above, so there is no flicker
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
    invalidateRect();
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

    // The background canvas is BG_OVERSCAN bigger than the screen on every side.
    // Its size, its position, its pixel resolution and the pan buffer's margin are
    // ALL derived from that one number, so they can never drift out of step again
    // (a mismatch between them is what caused the "ink jumps up" bug).
    const BG_FACTOR = 1 + 2 * BG_OVERSCAN;
    bgCanvas.style.left = bgCanvas.style.top = percent(-BG_OVERSCAN);
    bgCanvas.style.width = bgCanvas.style.height = percent(BG_FACTOR);

    function resize() {
      invalidateRect();
      const { w, h } = liveSize();
      halfW = w / 2; halfH = h / 2;
      resizeLayer(liveCanvas, liveCtx, w, h, 1.0);
      resizeLayer(bgCanvas, bgCtx, w, h, BG_FACTOR);
      panBuffer = new window.PanBuffer(camera, bgCanvas, BG_OVERSCAN);
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
      strokeTree = new QuadTree({ x: -S / 2, y: -S / 2, w: S, h: S });

      // Remember the original drawing order of every stroke
      canvasData.strokes.forEach((s, i) => { s._z = i; });

      // FIX: rebuild missing bounds so older strokes are still drawn
      for (const s of canvasData.strokes) {
        if (!hasPoints(s)) continue;
        if (!s.bounds) s.bounds = strokeBounds(s);
        strokeTree.insert(s);
      }

      $("canvas-title").textContent = data.title || "Untitled";

      // FIX: size the layers first (sets halfW/halfH and creates the pan buffer),
      // then centre the view. centerOnContent() already calls refreshUI().
      resize();
      centerOnContent();
    }).catch((err) => window.showError("Database error: " + err, "red"));
  }

  function centerOnContent() {
    if (!canvasData || canvasData.strokes.length === 0) return;

    const agg = Geo.emptyBounds();
    for (const s of canvasData.strokes) Geo.mergeBounds(agg, strokeBounds(s));
    if (!isFinite(agg.minX)) return;

    pendingPanDx = 0; pendingPanDy = 0; // discard stale queued movement

    camera.setPosition(
      (agg.minX + agg.maxX) / 2,
      (agg.minY + agg.maxY) / 2,
      CLAMP_SCALE(Geo.fitScale(
        agg.maxX - agg.minX, agg.maxY - agg.minY,
        halfW * 2 || FALLBACK_VIEW.w, halfH * 2 || FALLBACK_VIEW.h, FIT_PAD
      )),
      0
    );

    refreshUI();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
