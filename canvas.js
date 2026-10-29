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

  const MIN_SCALE = 0.000000001;
  const MAX_SCALE = 1000000000;
  
  // HOW FAR YOU MUST ZOOM OUT BEFORE A STROKE DISAPPEARS
  // 0.1 means it disappears when zoomed out to 10% of its original drawn size
  const CULL_FACTOR = 0.1;

  const camera = { x: 0, y: 0, scale: 1, rotation: 0 };
  const pointers = new Map();
  let gesture = null;
  let currentStroke = null;
  let pendingSave = null;
  let saveInFlight = false;
  let isPenDrawing = false;

  let currentTool = "pen";
  let currentSize = 4;
  let currentColor = "#1a1a2e";
  let rotationLocked = false;
  let rotationSnapHoldUntil = 0;

  function worldToScreen(wx, wy) {
    const dx = wx - camera.x;
    const dy = wy - camera.y;
    const cos = Math.cos(camera.rotation);
    const sin = Math.sin(camera.rotation);
    return {
      x: (dx * cos - dy * sin) * camera.scale + canvasEl.clientWidth / 2,
      y: (dx * sin + dy * cos) * camera.scale + canvasEl.clientHeight / 2
    };
  }

  function screenToWorld(sx, sy) {
    const px = sx - canvasEl.clientWidth / 2;
    const py = sy - canvasEl.clientHeight / 2;
    const cos = Math.cos(-camera.rotation);
    const sin = Math.sin(-camera.rotation);
    return {
      x: (px * cos - py * sin) / camera.scale + camera.x,
      y: (px * sin + py * cos) / camera.scale + camera.y
    };
  }

  function updateIndicators() {
    const scale = camera.scale;
    let zoomText = "";
    
    if (scale >= 0.01) {
      zoomText = Math.round(scale * 100) + "%";
    } else {
      zoomText = scale.toExponential(1);
    }
    document.getElementById("zoom-indicator").textContent = zoomText;

    const deg = Math.round(camera.rotation * 180 / Math.PI);
    document.getElementById("rotation-indicator").textContent = deg + "°";
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
    let spacing = 100;
    
    while (spacing * camera.scale < 30) spacing *= 2;
    while (spacing * camera.scale > 60) spacing /= 2;

    c.save();
    c.fillStyle = "#d0d0d8";
    
    const halfDiag = Math.sqrt(w * w + h * h) / 2 / camera.scale;
    const viewLeft = camera.x - halfDiag;
    const viewRight = camera.x + halfDiag;
    const viewTop = camera.y - halfDiag;
    const viewBottom = camera.y + halfDiag;

    const startX = Math.floor(viewLeft / spacing) * spacing;
    const startY = Math.floor(viewTop / spacing) * spacing;
    
    for (let wx = startX; wx <= viewRight; wx += spacing) {
      for (let wy = startY; wy <= viewBottom; wy += spacing) {
        const s = worldToScreen(wx, wy);
        c.beginPath();
        c.arc(s.x, s.y, 1.5, 0, Math.PI * 2);
        c.fill();
      }
    }
    c.restore();
  }

  function drawStrokeOn(c, stroke, isEraser) {
    if (!stroke.points || stroke.points.length === 0) return;
    
    // Absolute safety limit for physical pixels
    const screenWidth = (stroke.width || 4) * camera.scale;
    if (screenWidth < 0.1) return;

    c.save();
    c.lineCap = "round";
    c.lineJoin = "round";
    c.strokeStyle = isEraser ? "#fbfaf7" : (stroke.color || "#1a1a2e");
    c.fillStyle = isEraser ? "#fbfaf7" : (stroke.color || "#1a1a2e");
    
    c.lineWidth = screenWidth;

    if (stroke.points.length === 1) {
      const p = worldToScreen(stroke.points[0].x, stroke.points[0].y);
      c.beginPath();
      c.arc(p.x, p.y, c.lineWidth / 2, 0, Math.PI * 2);
      c.fill();
    } else {
      c.beginPath();
      const p0 = worldToScreen(stroke.points[0].x, stroke.points[0].y);
      c.moveTo(p0.x, p0.y);

      for (let i = 1; i < stroke.points.length - 1; i++) {
        const p1 = worldToScreen(stroke.points[i].x, stroke.points[i].y);
        const p2 = worldToScreen(stroke.points[i + 1].x, stroke.points[i + 1].y);
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;
        c.quadraticCurveTo(p1.x, p1.y, midX, midY);
      }
      
      const lastP = worldToScreen(stroke.points[stroke.points.length - 1].x, stroke.points[stroke.points.length - 1].y);
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
      const w = canvasEl.clientWidth;
      const h = canvasEl.clientHeight;
      const halfDiag = Math.sqrt(w * w + h * h) / 2 / camera.scale;
      const viewLeft = camera.x - halfDiag;
      const viewRight = camera.x + halfDiag;
      const viewTop = camera.y - halfDiag;
      const viewBottom = camera.y + halfDiag;

      for (let i = 0; i < canvasData.strokes.length; i++) {
        const s = canvasData.strokes[i];
        if (s.points.length > 0) {
          
          // FACTOR CULLING: Does this stroke belong to a zoom level far bigger than right now?
          const originScale = s.originScale || 1.0;
          if (camera.scale < originScale * CULL_FACTOR) continue;

          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          for (let j = 0; j < s.points.length; j++) {
            if (s.points[j].x < minX) minX = s.points[j].x;
            if (s.points[j].x > maxX) maxX = s.points[j].x;
            if (s.points[j].y < minY) minY = s.points[j].y;
            if (s.points[j].y > maxY) maxY = s.points[j].y;
          }
          
          if (maxX < viewLeft || minX > viewRight || maxY < viewTop || minY > viewBottom) continue;
        }
        drawStrokeOn(bgCtx, s, s.isEraser);
      }
    }
    bgDirty = false;
  }

  let renderScheduled = false;
  function redraw() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(function() {
      renderScheduled = false;
      if (!ctx) return;
      renderBackground();
      const w = canvasEl.clientWidth;
      const h = canvasEl.clientHeight;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(bgCanvas, 0, 0, w, h);
      if (currentStroke) {
        drawStrokeOn(ctx, currentStroke, currentStroke.isEraser);
      }
    });
  }

  function pointerDown(e) {
    e.preventDefault();
    if (canvasEl.setPointerCapture) {
      try { canvasEl.setPointerCapture(e.pointerId); } catch (err) { }
    }

    if (e.pointerType === "touch" && isPenDrawing) return;

    const rect = canvasEl.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;

    if (e.pointerType === "touch") {
      pointers.set(e.pointerId, { x: localX, y: localY });
      if (pointers.size === 2) {
        currentStroke = null;
        const pts = Array.from(pointers.values());
        const dx = pts[1].x - pts[0].x;
        const dy = pts[1].y - pts[0].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const angle = Math.atan2(dy, dx);
        const midX = (pts[0].x + pts[1].x) / 2;
        const midY = (pts[0].y + pts[1].y) / 2;
        
        const startWorld = screenToWorld(midX, midY);
        
        gesture = {
          type: "pinch",
          startDist: dist,
          startAngle: angle,
          startScale: camera.scale,
          startRotation: camera.rotation,
          startMid: { x: midX, y: midY },
          startWorld: startWorld
        };
      }
      return;
    }

    if ((e.pointerType === "pen" || e.pointerType === "mouse") && pointers.size === 0) {
      if (e.pointerType === "pen") isPenDrawing = true;
      pointers.set(e.pointerId, { x: localX, y: localY });
      
      const w = screenToWorld(localX, localY);
      currentStroke = {
        id: Store.uuid(),
        points: [{ x: w.x, y: w.y }],
        color: currentColor,
        width: currentSize,
        isEraser: currentTool === "eraser",
        originScale: camera.scale // <--- Record the zoom level!
      };
      gesture = { type: "draw" };
    }
    redraw();
  }

  function pointerMove(e) {
    if (e.pointerType === "touch" && isPenDrawing) return;
    if (!pointers.has(e.pointerId)) return;
    
    e.preventDefault();
    const rect = canvasEl.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    pointers.set(e.pointerId, { x: localX, y: localY });

    if (gesture && gesture.type === "draw" && currentStroke && pointers.size === 1) {
      if (e.pointerType === "touch") return;

      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const evX = ev.clientX - rect.left;
        const evY = ev.clientY - rect.top;
        const w = screenToWorld(evX, evY);
        currentStroke.points.push({ x: w.x, y: w.y });
      }
      redraw();
      
    } else if (gesture && gesture.type === "pinch" && pointers.size >= 2) {
      const pts = Array.from(pointers.values());
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const currentAngle = Math.atan2(dy, dx);
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;

      const vw = canvasEl.clientWidth;
      const vh = canvasEl.clientHeight;

      const ratio = dist / gesture.startDist;
      
      let newScale = gesture.startScale * ratio;
      newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));

      let newRotation = gesture.startRotation;
      if (!rotationLocked && Date.now() >= rotationSnapHoldUntil) {
        newRotation = gesture.startRotation + (currentAngle - gesture.startAngle);
      }

      const mdx = midX - vw / 2;
      const mdy = midY - vh / 2;
      const cosNeg = Math.cos(-newRotation);
      const sinNeg = Math.sin(-newRotation);
      const rx = mdx * cosNeg - mdy * sinNeg;
      const ry = mdx * sinNeg + mdy * cosNeg;

      camera.scale = newScale;
      camera.rotation = newRotation;
      camera.x = gesture.startWorld.x - rx / newScale;
      camera.y = gesture.startWorld.y - ry / newScale;
      
      updateIndicators();
      invalidateBackground();
      redraw();
    }
  }

  function pointerUp(e) {
    if (e.pointerType === "touch" && isPenDrawing) return;
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
    } else if (gesture && gesture.type === "pinch" && pointers.size < 2) {
      if (!rotationLocked && Math.abs(camera.rotation) < 5 * Math.PI / 180) {
        camera.rotation = 0;
        rotationSnapHoldUntil = Date.now() + 1000;
        updateIndicators();
        invalidateBackground();
      }
      gesture = null;
    }
    redraw();
  }

  function requestSave() {
    if (!canvasData) return;
    canvasData.modifiedAt = Date.now();
    pendingSave = canvasData;
    if (!saveInFlight) flushSave();
  }

  function flushSave() {
    if (!pendingSave) { saveInFlight = false; return; }
    const snapshot = pendingSave;
    pendingSave = null;
    saveInFlight = true;
    Store.save(snapshot).then(function () {
      if (pendingSave) flushSave();
      else saveInFlight = false;
    }).catch(function (err) {
      saveInFlight = false;
      if (window.showError) window.showError("Could not save: " + err);
    });
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
      camera.rotation = 0;
      
      const w = canvasEl.clientWidth;
      const h = canvasEl.clientHeight;
      const contentW = maxX - minX + 200;
      const contentH = maxY - minY + 200;
      
      let newScale = Math.min(w / contentW, h / contentH);
      newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
      camera.scale = newScale;
      
      updateIndicators();
      invalidateBackground();
      redraw();
    }
  }

  function wireToolbar() {
    document.querySelectorAll('.tool-btn[data-tool]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTool = btn.getAttribute('data-tool');
      });
    });

    document.querySelectorAll('.size-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentSize = parseInt(btn.getAttribute('data-size'), 10);
      });
    });

    document.querySelectorAll('.color-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentColor = btn.getAttribute('data-color');
      });
    });

    document.getElementById('lost-btn').addEventListener('click', centerOnContent);
    
    var lockBtn = document.getElementById('rotate-lock-btn');
    lockBtn.addEventListener('click', function() {
      rotationLocked = !rotationLocked;
      this.textContent = rotationLocked ? 'ROT 🔒' : 'ROT 🔓';
      if (rotationLocked) {
        this.classList.add('active');
      } else {
        this.classList.remove('active');
      }
    });
  }

  function setupEvents() {
    canvasEl.addEventListener("pointerdown", pointerDown);
    canvasEl.addEventListener("pointermove", pointerMove);
    canvasEl.addEventListener("pointerup", pointerUp);
    canvasEl.addEventListener("pointercancel", pointerUp);

    document.getElementById("back-btn").addEventListener("click", function () {
      if (saveInFlight || pendingSave) {
        if (window.showError) window.showError("Saving... please wait.");
        setTimeout(function() { window.location.href = "index.html"; }, 500);
      } else {
        window.location.href = "index.html";
      }
    });
    
    wireToolbar();
  }

  function init() {
    setupCanvas();

    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    if (!id) { window.location.href = "index.html"; return; }

    Store.get(id).then(function (data) {
      if (!data) { window.location.href = "index.html"; return; }
      canvasData = data;
      document.getElementById("canvas-title").textContent = data.title || "Untitled";
      setupEvents();
      centerOnContent();
      updateIndicators();
      redraw();
    }).catch(function (err) {
      if (window.showError) window.showError("Could not load canvas: " + err);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
