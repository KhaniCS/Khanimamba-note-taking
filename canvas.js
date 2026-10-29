(function () {
  "use strict";

  if (!window.Store) {
    if (window.showError) window.showError("store.js did not load.");
    return;
  }

  const Store = window.Store;

  let canvasData = null;
  let ctx = null;
  let canvasEl = null;
  let dpr = window.devicePixelRatio || 1;
  let bgCanvas = null;
  let bgCtx = null;
  let bgDirty = true;

  const camera = { x: 0, y: 0, scale: 1 };
  const pointers = new Map();
  let gesture = null;
  let currentStroke = null;
  let pendingSave = null;
  let saveInFlight = false;
  let isPenDrawing = false;

  function worldToScreen(wx, wy) {
    return {
      x: (wx - camera.x) * camera.scale + canvasEl.clientWidth / 2,
      y: (wy - camera.y) * camera.scale + canvasEl.clientHeight / 2
    };
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - canvasEl.clientWidth / 2) / camera.scale + camera.x,
      y: (sy - canvasEl.clientHeight / 2) / camera.scale + camera.y
    };
  }

  function invalidateBackground() { bgDirty = true; }

  function setupCanvas() {
    canvasEl = document.getElementById("draw-surface");
    ctx = canvasEl.getContext("2d");
    bgCanvas = document.createElement("canvas");
    bgCtx = bgCanvas.getContext("2d");
    resize();
    window.addEventListener("resize", resize);
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const rect = canvasEl.getBoundingClientRect();
    canvasEl.width = Math.round(rect.width * dpr);
    canvasEl.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    invalidateBackground();
    redraw();
  }

  function drawGrid(c) {
    const w = canvasEl.clientWidth;
    const h = canvasEl.clientHeight;
    const spacing = 100;
    if (spacing * camera.scale < 12) return;
    c.save();
    c.fillStyle = "#d0d0d8";
    const tl = screenToWorld(0, 0);
    const br = screenToWorld(w, h);
    const startX = Math.floor(tl.x / spacing) * spacing;
    const startY = Math.floor(tl.y / spacing) * spacing;
    for (let wx = startX; wx <= br.x; wx += spacing) {
      for (let wy = startY; wy <= br.y; wy += spacing) {
        const s = worldToScreen(wx, wy);
        c.beginPath();
        c.arc(s.x, s.y, 1.5, 0, Math.PI * 2);
        c.fill();
      }
    }
    c.restore();
  }

  function drawStrokeOn(c, stroke) {
    if (!stroke.points || stroke.points.length === 0) return;
    c.save();
    c.lineCap = "round";
    c.lineJoin = "round";
    c.strokeStyle = stroke.color || "#1a1a2e";
    c.fillStyle = stroke.color || "#1a1a2e";
    c.lineWidth = (stroke.width || 2) * camera.scale;

    if (stroke.points.length === 1) {
      const p = worldToScreen(stroke.points[0].x, stroke.points[0].y);
      c.beginPath();
      c.arc(p.x, p.y, c.lineWidth / 2, 0, Math.PI * 2);
      c.fill();
    } else {
      c.beginPath();
      const p0 = worldToScreen(stroke.points[0].x, stroke.points[0].y);
      c.moveTo(p0.x, p0.y);

      // Smooth curve drawing
      for (let i = 1; i < stroke.points.length - 1; i++) {
        const p1 = worldToScreen(stroke.points[i].x, stroke.points[i].y);
        const p2 = worldToScreen(stroke.points[i + 1].x, stroke.points[i + 1].y);
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;
        c.quadraticCurveTo(p1.x, p1.y, midX, midY);
      }
      
      const lastP = worldToScreen(
        stroke.points[stroke.points.length - 1].x, 
        stroke.points[stroke.points.length - 1].y
      );
      c.lineTo(lastP.x, lastP.y);
      c.stroke();
    }
    c.restore();
  }

  function renderBackground() {
    if (!bgDirty) return;
    bgCanvas.width = canvasEl.width;
    bgCanvas.height = canvasEl.height;
    bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bgCtx.clearRect(0, 0, canvasEl.clientWidth, canvasEl.clientHeight);
    drawGrid(bgCtx);
    if (canvasData) {
      for (let i = 0; i < canvasData.strokes.length; i++) {
        drawStrokeOn(bgCtx, canvasData.strokes[i]);
      }
    }
    bgDirty = false;
  }

  function redraw() {
    if (!ctx) return;
    renderBackground();
    const w = canvasEl.clientWidth;
    const h = canvasEl.clientHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(bgCanvas, 0, 0, w, h);
    if (currentStroke) {
      drawStrokeOn(ctx, currentStroke);
    }
  }

  function pointerDown(e) {
    e.preventDefault();
    if (canvasEl.setPointerCapture) {
      try { canvasEl.setPointerCapture(e.pointerId); } catch (err) { }
    }
    
    if (e.pointerType === "touch" && isPenDrawing) return;
    if (e.pointerType === "pen") isPenDrawing = true;

    // Store local canvas coordinates for perfect zoom tracking
    const rect = canvasEl.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    pointers.set(e.pointerId, { x: localX, y: localY });

    if (pointers.size === 1) {
      const w = screenToWorld(localX, localY);
      
      currentStroke = {
        id: Store.uuid(),
        points: [{ x: w.x, y: w.y }],
        color: "#1a1a2e",
        width: 2.5
      };
      gesture = { type: "draw" };
    } else if (pointers.size === 2) {
      currentStroke = null;
      const pts = Array.from(pointers.values());
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      gesture = {
        type: "zoom",
        startDist: dist,
        startCam: { x: camera.x, y: camera.y, scale: camera.scale },
        startMid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
      };
    }
    redraw();
  }

  function pointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    e.preventDefault();
    
    const rect = canvasEl.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    pointers.set(e.pointerId, { x: localX, y: localY });

    if (gesture && gesture.type === "draw" && currentStroke && pointers.size === 1) {
      // Capture all high-speed Apple Pencil data
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        // Use offsetX/Y to guarantee we ignore the header offset entirely
        const evX = ev.offsetX !== undefined ? ev.offsetX : (ev.clientX - rect.left);
        const evY = ev.offsetY !== undefined ? ev.offsetY : (ev.clientY - rect.top);
        
        const w = screenToWorld(evX, evY);
        currentStroke.points.push({ x: w.x, y: w.y });
      }
      redraw();
      
    } else if (gesture && gesture.type === "zoom" && pointers.size >= 2) {
      const pts = Array.from(pointers.values());
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const ratio = dist / gesture.startDist;
      const newScale = Math.max(0.1, Math.min(20, gesture.startCam.scale * ratio));
      const vw = canvasEl.clientWidth;
      const vh = canvasEl.clientHeight;
      const startWorld = {
        x: (gesture.startMid.x - vw / 2) / gesture.startCam.scale + gesture.startCam.x,
        y: (gesture.startMid.y - vh / 2) / gesture.startCam.scale + gesture.startCam.y
      };
      camera.scale = newScale;
      camera.x = startWorld.x - (mid.x - vw / 2) / newScale;
      camera.y = startWorld.y - (mid.y - vh / 2) / newScale;
      invalidateBackground();
      redraw();
    }
  }

  function pointerUp(e) {
    if (!pointers.has(e.pointerId)) return;
    e.preventDefault();
    pointers.delete(e.pointerId);
    if (canvasEl.releasePointerCapture) {
      try { canvasEl.releasePointerCapture(e.pointerId); } catch (err) { }
    }

    if (e.pointerType === "pen") isPenDrawing = false;

    if (gesture && gesture.type === "draw" && currentStroke) {
      if (currentStroke.points.length > 0 && canvasData) {
        canvasData.strokes.push(currentStroke);
        invalidateBackground();
        requestSave();
      }
      currentStroke = null;
      gesture = null;
    } else if (gesture && gesture.type === "zoom" && pointers.size < 2) {
      gesture = null;
    }
    redraw();
  }

  function requestSave() {
    if (!canvasData) return;
    canvasData.modifiedAt = Date.now();
    pendingSave = canvasData;
    if (!saveInFlight) {
      flushSave();
    }
  }

  function flushSave() {
    if (!pendingSave) { saveInFlight = false; return; }
    const snapshot = pendingSave;
    pendingSave = null;
    saveInFlight = true;
    Store.save(snapshot).then(function () {
      if (pendingSave) {
        flushSave();
      } else {
        saveInFlight = false;
      }
    }).catch(function (err) {
      saveInFlight = false;
      window.showError("Could not save: " + err);
    });
  }

  function undo() {
    if (!canvasData || canvasData.strokes.length === 0) return;
    canvasData.strokes.pop();
    invalidateBackground();
    requestSave();
    redraw();
  }

  function clearAll() {
    if (!canvasData || canvasData.strokes.length === 0) return;
    if (!confirm("Clear all strokes on this canvas?")) return;
    canvasData.strokes = [];
    invalidateBackground();
    requestSave();
    redraw();
  }

  function centerOnContent() {
    if (!canvasData || canvasData.strokes.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < canvasData.strokes.length; i++) {
      const pts = canvasData.strokes[i].points || [];
      for (let j = 0; j < pts.length; j++) {
        const p = pts[j];
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
    if (isFinite(minX) && isFinite(minY)) {
      camera.x = (minX + maxX) / 2;
      camera.y = (minY + maxY) / 2;
      invalidateBackground();
    }
  }

  function setupEvents() {
    canvasEl.addEventListener("pointerdown", pointerDown);
    canvasEl.addEventListener("pointermove", pointerMove);
    canvasEl.addEventListener("pointerup", pointerUp);
    canvasEl.addEventListener("pointercancel", pointerUp);

    document.getElementById("back-btn").addEventListener("click", function () {
      if (saveInFlight || pendingSave) {
        window.showError("Saving... please wait a moment.");
        setTimeout(function() { window.location.href = "index.html"; }, 500);
      } else {
        window.location.href = "index.html";
      }
    });
    
    document.getElementById("undo-btn").addEventListener("click", undo);
    document.getElementById("clear-btn").addEventListener("click", clearAll);
  }

  function init() {
    setupCanvas();

    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    if (!id) {
      window.location.href = "index.html";
      return;
    }

    Store.get(id).then(function (data) {
      if (!data) {
        window.location.href = "index.html";
        return;
      }
      canvasData = data;
      document.getElementById("canvas-title").textContent = data.title || "Untitled";
      setupEvents();
      centerOnContent();
      redraw();
    }).catch(function (err) {
      window.showError("Could not load canvas: " + err);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
