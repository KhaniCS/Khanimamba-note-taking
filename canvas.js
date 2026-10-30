(function () {
  "use strict";

  // --- DEPENDENCY CHECKS (Fail loudly if a file is missing) ---
  if (!window.Store) return window.showError("store.js is missing.", "orange");
  if (!window.Camera) return window.showError("camera.js is missing. Did you create the file?", "orange");
  if (!window.PanBuffer) return window.showError("panbuffer.js is missing. Did you create the file?", "orange");
  if (!window.Toolbar) return window.showError("toolbar.js is missing. Did you create the file?", "orange");
  if (!window.AutoSaver) return window.showError("autosaver.js is missing. Did you create the file?", "orange");

  const Store = window.Store;
  const camera = new window.Camera();
  const toolbar = new window.Toolbar();
  const autosaver = new window.AutoSaver(Store, 5000);
  
  let panBuffer = null;
  let canvasData = null;

  let bgCanvas = null, bgCtx = null;
  let liveCanvas = null, liveCtx = null;
  let toolbarEl = null;

  let currentStroke = null;
  let isPenActive = false;
  let screenPointCount = 0;
  const MAX_POINTS = 50000;
  const screenPoints = new Float32Array(MAX_POINTS * 2);
  let strokeOriginCamera = null;

  // --- INDICATORS ---
  function updateIndicators() {
    const scale = camera.scale;
    const zoomEl = document.getElementById("zoom-indicator");
    const rotEl = document.getElementById("rotation-indicator");
    
    if (zoomEl) {
      zoomEl.textContent = scale >= 0.01 ? Math.round(scale * 100) + "%" : scale.toExponential(1);
    }
    if (rotEl) {
      const deg = Math.round(camera.rotation * 180 / Math.PI);
      rotEl.textContent = deg + "°";
    }
  }

  // --- QUADTREE ---
  class QuadTree {
    constructor(bounds, maxObjects, maxLevels, level) {
      this.bounds = bounds; this.maxObjects = maxObjects || 10; this.maxLevels = maxLevels || 4; this.level = level || 0;
      this.objects = []; this.nodes = [];
    }
    split() {
      const nextLevel = this.level + 1; const w = this.bounds.w / 2; const h = this.bounds.h / 2;
      const x = this.bounds.x; const y = this.bounds.y;
      this.nodes[0] = new QuadTree({ x: x + w, y: y, w: w, h: h }, this.maxObjects, this.maxLevels, nextLevel);
      this.nodes[1] = new QuadTree({ x: x, y: y, w: w, h: h }, this.maxObjects, this.maxLevels, nextLevel);
      this.nodes[2] = new QuadTree({ x: x, y: y + h, w: w, h: h }, this.maxObjects, this.maxLevels, nextLevel);
      this.nodes[3] = new QuadTree({ x: x + w, y: y + h, w: w, h: h }, this.maxObjects, this.maxLevels, nextLevel);
    }
    getIndex(box) {
      let index = -1; const midX = this.bounds.x + this.bounds.w / 2; const midY = this.bounds.y + this.bounds.h / 2;
      const top = (box.minY < midY && box.maxY < midY); const bottom = (box.minY > midY);
      if (box.minX < midX && box.maxX < midX) { if (top) index = 1; else if (bottom) index = 2; }
      else if (box.minX > midX) { if (top) index = 0; else if (bottom) index = 3; }
      return index;
    }
    insert(item) {
      if (this.nodes.length) { const index = this.getIndex(item.bounds); if (index !== -1) { this.nodes[index].insert(item); return; } }
      this.objects.push(item);
      if (this.objects.length > this.maxObjects && this.level < this.maxLevels) {
        if (!this.nodes.length) this.split();
        let i = 0;
        while (i < this.objects.length) {
          const index = this.getIndex(this.objects[i].bounds);
          if (index !== -1) this.nodes[index].insert(this.objects.splice(i, 1)[0]); else i++;
        }
      }
    }
    retrieve(box) {
      let returnObjects = this.objects;
      if (this.nodes.length) {
        const index = this.getIndex(box);
        if (index !== -1) returnObjects = returnObjects.concat(this.nodes[index].retrieve(box));
        else for (let i = 0; i < this.nodes.length; i++) returnObjects = returnObjects.concat(this.nodes[i].retrieve(box));
      }
      return returnObjects;
    }
  }
  let strokeTree = null;

  // --- RENDERING LOGIC ---
  function drawGrid(c, w, h, cx, cy) {
    let spacing = 100;
    while (spacing * camera.scale < 30) spacing *= 2;
    while (spacing * camera.scale > 60) spacing /= 2;

    const bounds = camera.getVisibleBounds(w, h, cx, cy);
    const startX = Math.floor(bounds.minX / spacing) * spacing;
    const startY = Math.floor(bounds.minY / spacing) * spacing;

    c.fillStyle = "#d0d0d8";
    for (let wx = startX; wx <= bounds.maxX; wx += spacing) {
      for (let wy = startY; wy <= bounds.maxY; wy += spacing) {
        const sx = wx * camera.a - wy * camera.b + camera.tx;
        const sy = wx * camera.b + wy * camera.a + camera.ty;
        c.beginPath(); c.arc(sx, sy, 1.5, 0, Math.PI * 2); c.fill();
      }
    }
  }

  function drawStrokeOn(c, stroke) {
    if (!stroke.points || stroke.points.length === 0) return;
    const screenWidth = (stroke.width || 4) * camera.scale;
    if (screenWidth < 0.1) return;

    c.lineCap = "round"; c.lineJoin = "round";
    c.strokeStyle = stroke.isEraser ? "#fbfaf7" : (stroke.color || "#1a1a2e");
    c.fillStyle = stroke.isEraser ? "#fbfaf7" : (stroke.color || "#1a1a2e");
    c.lineWidth = screenWidth;

    if (stroke.points.length === 1) {
      const sx = stroke.points[0].x * camera.a - stroke.points[0].y * camera.b + camera.tx;
      const sy = stroke.points[0].x * camera.b + stroke.points[0].y * camera.a + camera.ty;
      c.beginPath(); c.arc(sx, sy, c.lineWidth / 2, 0, Math.PI * 2); c.fill();
    } else {
      c.beginPath();
      let sx = stroke.points[0].x * camera.a - stroke.points[0].y * camera.b + camera.tx;
      let sy = stroke.points[0].x * camera.b + stroke.points[0].y * camera.a + camera.ty;
      c.moveTo(sx, sy);

      for (let i = 1; i < stroke.points.length - 1; i++) {
        const p1x = stroke.points[i].x * camera.a - stroke.points[i].y * camera.b + camera.tx;
        const p1y = stroke.points[i].x * camera.b + stroke.points[i].y * camera.a + camera.ty;
        const p2x = stroke.points[i + 1].x * camera.a - stroke.points[i + 1].y * camera.b + camera.tx;
        const p2y = stroke.points[i + 1].x * camera.b + stroke.points[i + 1].y * camera.a + camera.ty;
        c.quadraticCurveTo(p1x, p1y, (p1x + p2x) / 2, (p1y + p2y) / 2);
      }
      const lastIdx = stroke.points.length - 1;
      sx = stroke.points[lastIdx].x * camera.a - stroke.points[lastIdx].y * camera.b + camera.tx;
      sy = stroke.points[lastIdx].x * camera.b + stroke.points[lastIdx].y * camera.a + camera.ty;
      c.lineTo(sx, sy); c.stroke();
    }
  }

  function renderBackground() {
    const w = bgCanvas.width / (window.devicePixelRatio || 1);
    const h = bgCanvas.height / (window.devicePixelRatio || 1);
    const cx = w / 2; const cy = h / 2;

    camera.updateMatrix(cx, cy);
    bgCtx.clearRect(0, 0, w, h);
    drawGrid(bgCtx, w, h, cx, cy);
    
    if (canvasData) {
      const viewBox = camera.getVisibleBounds(w, h, cx, cy);
      const visibleStrokes = strokeTree ? strokeTree.retrieve(viewBox) : canvasData.strokes;
      for (let i = 0; i < visibleStrokes.length; i++) {
        drawStrokeOn(bgCtx, visibleStrokes[i]);
      }
    }
  }

  let renderScheduled = false;
  function redrawLive() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      liveCtx.clearRect(0, 0, liveCanvas.clientWidth, liveCanvas.clientHeight);
      if (currentStroke && screenPointCount > 0) {
        liveCtx.lineCap = "round"; liveCtx.lineJoin = "round";
        liveCtx.strokeStyle = currentStroke.isEraser ? "#fbfaf7" : currentStroke.color;
        liveCtx.lineWidth = currentStroke.width * camera.scale;
        liveCtx.beginPath();
        for (let i = 0; i < screenPointCount; i++) {
          const sx = screenPoints[i * 2]; const sy = screenPoints[i * 2 + 1];
          if (i === 0) liveCtx.moveTo(sx, sy); else liveCtx.lineTo(sx, sy);
        }
        liveCtx.stroke();
      }
    });
  }

  // --- INPUT HANDLING ---
  function penDown(e) {
    if (e.pointerType !== "pen" && e.pointerType !== "mouse") return;
    e.preventDefault();
    isPenActive = true;
    if (toolbarEl) toolbarEl.style.pointerEvents = "none";

    const rect = liveCanvas.getBoundingClientRect();
    const sx = e.clientX - rect.left; const sy = e.clientY - rect.top;

    strokeOriginCamera = { x: camera.x, y: camera.y, scale: camera.scale, rotation: camera.rotation };
    currentStroke = {
      id: Store.uuid(), points: [], color: toolbar.currentColor,
      width: toolbar.currentSize / camera.scale, isEraser: toolbar.currentTool === "eraser", originScale: camera.scale
    };
    
    screenPointCount = 0;
    screenPoints[0] = sx; screenPoints[1] = sy; screenPointCount++;
    redrawLive();
  }

  function penMove(e) {
    if (e.pointerType !== "pen" && e.pointerType !== "mouse") return;
    if (!currentStroke || screenPointCount >= MAX_POINTS) return;

    const rect = liveCanvas.getBoundingClientRect();
    const sx = e.clientX - rect.left; const sy = e.clientY - rect.top;
    const lastX = screenPoints[(screenPointCount - 1) * 2];
    const lastY = screenPoints[(screenPointCount - 1) * 2 + 1];

    if ((sx - lastX) ** 2 + (sy - lastY) ** 2 < 2.25) return;

    screenPoints[screenPointCount * 2] = sx; screenPoints[screenPointCount * 2 + 1] = sy;
    screenPointCount++;
    redrawLive();
  }

  function penUp(e) {
    if (e.pointerType !== "pen" && e.pointerType !== "mouse") return;
    isPenActive = false;
    if (toolbarEl) toolbarEl.style.pointerEvents = "auto";

    if (currentStroke && screenPointCount > 0) {
      const c = strokeOriginCamera;
      const cos = Math.cos(-c.rotation); const sin = Math.sin(-c.rotation);
      const cx = liveCanvas.clientWidth / 2; 
      const cy = liveCanvas.clientHeight / 2;

      for (let i = 0; i < screenPointCount; i++) {
        const px = screenPoints[i * 2] - cx; const py = screenPoints[i * 2 + 1] - cy;
        currentStroke.points.push({
          x: (px * cos - py * sin) / c.scale + c.x,
          y: (px * sin + py * cos) / c.scale + c.y
        });
      }

      if (canvasData) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < currentStroke.points.length; i++) {
          if (currentStroke.points[i].x < minX) minX = currentStroke.points[i].x;
          if (currentStroke.points[i].x > maxX) maxX = currentStroke.points[i].x;
          if (currentStroke.points[i].y < minY) minY = currentStroke.points[i].y;
          if (currentStroke.points[i].y > maxY) maxY = currentStroke.points[i].y;
        }
        currentStroke.bounds = { minX, minY, maxX, maxY };
        canvasData.strokes.push(currentStroke);
        if (strokeTree) strokeTree.insert(currentStroke);
        autosaver.schedule(canvasData);
      }
      currentStroke = null;
      renderBackground();
      redrawLive();
    }
  }

  // --- TOUCH (PAN & ZOOM) ---
  const touchCtx = { gesture: null };

  function touchStart(e) {
    if (isPenActive) return;
    const rect = liveCanvas.getBoundingClientRect();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      touchCtx.gesture = { type: "pending_pan", startX: t.clientX - rect.left, startY: t.clientY - rect.top };
    } else if (e.touches.length === 2) {
      const t0 = e.touches[0]; const t1 = e.touches[1];
      const dx = (t1.clientX - rect.left) - (t0.clientX - rect.left);
      const dy = (t1.clientY - rect.top) - (t0.clientY - rect.top);
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const angle = Math.atan2(dy, dx);
      const midX = (t0.clientX - rect.left + t1.clientX - rect.left) / 2;
      const midY = (t0.clientY - rect.top + t1.clientY - rect.top) / 2;
      touchCtx.gesture = {
        type: "pinch", startDist: dist, startAngle: angle,
        startScale: camera.scale, startRotation: camera.rotation,
        startMid: { x: midX, y: midY }
      };
    }
  }

  function touchMove(e) {
    if (isPenActive || !touchCtx.gesture) return;
    e.preventDefault(); 
    const rect = liveCanvas.getBoundingClientRect();

    if (touchCtx.gesture.type === "pending_pan" && e.touches.length === 1) {
      const t = e.touches[0];
      const localX = t.clientX - rect.left; const localY = t.clientY - rect.top;
      if ((localX - touchCtx.gesture.startX) ** 2 + (localY - touchCtx.gesture.startY) ** 2 > 225) {
        touchCtx.gesture = { type: "pan", lastX: localX, lastY: localY };
      }
    } else if (touchCtx.gesture.type === "pan" && e.touches.length === 1) {
      const t = e.touches[0];
      const localX = t.clientX - rect.left; const localY = t.clientY - rect.top;
      const dx = localX - touchCtx.gesture.lastX; const dy = localY - touchCtx.gesture.lastY;
      
      const needsRender = panBuffer.addDelta(dx, dy, liveCanvas.clientWidth, liveCanvas.clientHeight);
      
      const cos = Math.cos(-camera.rotation); const sin = Math.sin(-camera.rotation);
      camera.x -= (dx * cos - dy * sin) / camera.scale;
      camera.y -= (dx * sin + dy * cos) / camera.scale;
      camera.markPanDirty();
      
      touchCtx.gesture.lastX = localX; touchCtx.gesture.lastY = localY;
      
      if (needsRender) {
        panBuffer.reset();
        renderBackground();
      }
    } else if (touchCtx.gesture.type === "pinch" && e.touches.length >= 2) {
      panBuffer.reset();
      const t0 = e.touches[0]; const t1 = e.touches[1];
      const dx = (t1.clientX - rect.left) - (t0.clientX - rect.left);
      const dy = (t1.clientY - rect.top) - (t0.clientY - rect.top);
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const currentAngle = Math.atan2(dy, dx);
      const midX = (t0.clientX - rect.left + t1.clientX - rect.left) / 2;
      const midY = (t0.clientY - rect.top + t1.clientY - rect.top) / 2;
      
      let newScale = touchCtx.gesture.startScale * (dist / touchCtx.gesture.startDist);
      if (toolbar.zoomLocked) newScale = touchCtx.gesture.startScale;
      else newScale = Math.max(0.000000001, Math.min(1000000000, newScale));
      
      let newRotation = touchCtx.gesture.startRotation;
      if (!toolbar.rotationLocked && Date.now() >= toolbar.rotationSnapHoldUntil) {
        newRotation = touchCtx.gesture.startRotation + (currentAngle - touchCtx.gesture.startAngle);
      }
      
      const cx = liveCanvas.clientWidth / 2; const cy = liveCanvas.clientHeight / 2;
      const worldMid = camera.toWorld(midX, midY, cx, cy);

      camera.scale = newScale; camera.rotation = newRotation;
      camera.markDirty();

      const cosNeg = Math.cos(-newRotation); const sinNeg = Math.sin(-newRotation);
      const mdx = midX - cx; const mdy = midY - cy;
      camera.x = worldMid.x - (mdx * cosNeg - mdy * sinNeg) / newScale;
      camera.y = worldMid.y - (mdx * sinNeg + mdy * cosNeg) / newScale;

      updateIndicators();
      renderBackground();
    }
  }

  function touchEnd(e) {
    if (isPenActive || !touchCtx.gesture) return;
    if (e.touches.length === 0) {
      if (touchCtx.gesture.type === "pinch" && !toolbar.rotationLocked && Math.abs(camera.rotation) < 5 * Math.PI / 180) {
        camera.rotation = 0; 
        toolbar.rotationSnapHoldUntil = Date.now() + 1000; 
        camera.markDirty();
        updateIndicators();
        panBuffer.reset(); 
        renderBackground();
      }
      touchCtx.gesture = null;
    } else if (e.touches.length === 1 && touchCtx.gesture.type === "pinch") {
      const t = e.touches[0]; const r = liveCanvas.getBoundingClientRect();
      touchCtx.gesture = { type: "pending_pan", startX: t.clientX - r.left, startY: t.clientY - r.top };
    }
  }

  // --- INITIALIZATION ---
  function init() {
    bgCanvas = document.getElementById("bg-surface");
    liveCanvas = document.getElementById("draw-surface");
    toolbarEl = document.getElementById("toolbar");
    
    if (!bgCanvas || !liveCanvas || !toolbarEl) {
      return window.showError("HTML elements are missing. Did you update canvas.html?", "red");
    }

    bgCtx = bgCanvas.getContext("2d");
    liveCtx = liveCanvas.getContext("2d");

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = liveCanvas.clientWidth; const h = liveCanvas.clientHeight;
      
      liveCanvas.width = w * dpr; 
      liveCanvas.height = h * dpr;
      liveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

      bgCanvas.width = w * 1.4 * dpr; 
      bgCanvas.height = h * 1.4 * dpr;
      bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

      panBuffer = new window.PanBuffer(camera, bgCanvas);
      camera.markDirty();
      renderBackground();
    }

    window.addEventListener("resize", resize);
    
    toolbar.wire(centerOnContent, () => camera.markDirty(), () => {});
    
    // LIBRARY BUTTON (RESTORED)
    document.getElementById("back-btn").addEventListener("click", function () {
      if (autosaver.isSaving || autosaver.pendingData) {
        window.showError("Saving... please wait.", "orange");
        setTimeout(function() { window.location.href = "index.html"; }, 500);
      } else {
        window.location.href = "index.html";
      }
    });

    liveCanvas.addEventListener("pointerdown", penDown);
    liveCanvas.addEventListener("pointermove", penMove);
    liveCanvas.addEventListener("pointerup", penUp);
    
    liveCanvas.addEventListener("touchstart", touchStart, { passive: true });
    liveCanvas.addEventListener("touchmove", touchMove, { passive: false });
    liveCanvas.addEventListener("touchend", touchEnd, { passive: true });

    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    if (!id) return window.showError("No canvas ID provided.", "red");

    Store.get(id).then((data) => {
      canvasData = data;
      if (!canvasData.strokes) canvasData.strokes = [];
      
      const treeSize = 1000000;
      strokeTree = new QuadTree({ x: -treeSize/2, y: -treeSize/2, w: treeSize, h: treeSize }, 10, 5, 0);
      canvasData.strokes.forEach((s) => {
        if (s.points.length > 0 && s.bounds) strokeTree.insert(s);
      });

      document.getElementById("canvas-title").textContent = data.title || "Untitled";
      centerOnContent();
      updateIndicators();
      resize();
    }).catch((err) => {
      window.showError("Database error: " + err, "red");
    });
  }

  function centerOnContent() {
    if (!canvasData || canvasData.strokes.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    canvasData.strokes.forEach((s) => {
      (s.points || []).forEach((p) => {
        if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
      });
    });
    if (isFinite(minX)) {
      camera.x = (minX + maxX) / 2; 
      camera.y = (minY + maxY) / 2;
      camera.rotation = 0; 
      camera.scale = Math.min(1000 / (maxX - minX + 400), 800 / (maxY - minY + 400));
      camera.markDirty();
      if (panBuffer) panBuffer.reset();
      renderBackground();
      updateIndicators();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
