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
  let toolbarEl = null;
  let dpr = window.devicePixelRatio || 1;

  const MIN_SCALE = 0.000000001;
  const MAX_SCALE = 1000000000;
  const CULL_FACTOR = 0.1;

  const camera = { x: 0, y: 0, scale: 1, rotation: 0 };
  let gesture = null;
  let currentStroke = null;
  let pendingSave = null;
  let saveInFlight = false;

  let currentTool = "pen";
  let currentSize = 4;
  let currentColor = "#1a1a2e";
  let rotationLocked = false;
  let rotationSnapHoldUntil = 0;
  let zoomLocked = false;

  // --- THE STATE FLAG ---
  let isPenActive = false;

  // --- TYPED ARRAYS (Zero Object Allocation) ---
  const MAX_SCREEN_POINTS = 50000;
  const screenPoints = new Float32Array(MAX_SCREEN_POINTS * 2);
  let screenPointCount = 0;

  // --- FRAME TRANSFORM CACHE (Zero GC in render loop) ---
  const frameTransform = { cos: 1, sin: 1, cx: 0, cy: 0, scale: 1, camX: 0, camY: 0 };
  const viewportBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };

  let saveTimer = null;
  let strokeOriginCamera = null;

  // --- QUADTREE ---
  class QuadTree {
    constructor(bounds, maxObjects, maxLevels, level) {
      this.bounds = bounds;
      this.maxObjects = maxObjects || 10;
      this.maxLevels = maxLevels || 4;
      this.level = level || 0;
      this.objects = [];
      this.nodes = [];
    }
    split() {
      const nextLevel = this.level + 1;
      const w = this.bounds.w / 2;
      const h = this.bounds.h / 2;
      const x = this.bounds.x;
      const y = this.bounds.y;
      this.nodes[0] = new QuadTree({ x: x + w, y: y, w: w, h: h }, this.maxObjects, this.maxLevels, nextLevel);
      this.nodes[1] = new QuadTree({ x: x, y: y, w: w, h: h }, this.maxObjects, this.maxLevels, nextLevel);
      this.nodes[2] = new QuadTree({ x: x, y: y + h, w: w, h: h }, this.maxObjects, this.maxLevels, nextLevel);
      this.nodes[3] = new QuadTree({ x: x + w, y: y + h, w: w, h: h }, this.maxObjects, this.maxLevels, nextLevel);
    }
    getIndex(box) {
      let index = -1;
      const midX = this.bounds.x + this.bounds.w / 2;
      const midY = this.bounds.y + this.bounds.h / 2;
      const topQuadrant = (box.minY < midY && box.maxY < midY);
      const bottomQuadrant = (box.minY > midY);
      if (box.minX < midX && box.maxX < midX) {
        if (topQuadrant) index = 1;
        else if (bottomQuadrant) index = 2;
      } else if (box.minX > midX) {
        if (topQuadrant) index = 0;
        else if (bottomQuadrant) index = 3;
      }
      return index;
    }
    insert(item) {
      if (this.nodes.length) {
        const index = this.getIndex(item.bounds);
        if (index !== -1) {
          this.nodes[index].insert(item);
          return;
        }
      }
      this.objects.push(item);
      if (this.objects.length > this.maxObjects && this.level < this.maxLevels) {
        if (!this.nodes.length) this.split();
        let i = 0;
        while (i < this.objects.length) {
          const index = this.getIndex(this.objects[i].bounds);
          if (index !== -1) {
            this.nodes[index].insert(this.objects.splice(i, 1)[0]);
          } else {
            i++;
          }
        }
      }
    }
    retrieve(box) {
      let returnObjects = this.objects;
      if (this.nodes.length) {
        const index = this.getIndex(box);
        if (index !== -1) {
          returnObjects = returnObjects.concat(this.nodes[index].retrieve(box));
        } else {
          for (let i = 0; i < this.nodes.length; i++) {
            returnObjects = returnObjects.concat(this.nodes[i].retrieve(box));
          }
        }
      }
      return returnObjects;
    }
  }

  let strokeTree = null;

  function rebuildQuadtree() {
    const treeSize = 1000000;
    strokeTree = new QuadTree({ x: -treeSize/2, y: -treeSize/2, w: treeSize, h: treeSize }, 10, 5, 0);
    if (canvasData && canvasData.strokes) {
      for (let i = 0; i < canvasData.strokes.length; i++) {
        const s = canvasData.strokes[i];
        if (s.points.length > 0) {
          if (!s.bounds) {
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (let j = 0; j < s.points.length; j++) {
              if (s.points[j].x < minX) minX = s.points[j].x;
              if (s.points[j].x > maxX) maxX = s.points[j].x;
              if (s.points[j].y < minY) minY = s.points[j].y;
              if (s.points[j].y > maxY) maxY = s.points[j].y;
            }
            s.bounds = { minX, minY, maxX, maxY };
          }
          strokeTree.insert(s);
        }
      }
    }
  }

  function updateFrameTransform() {
    frameTransform.cos = Math.cos(camera.rotation);
    frameTransform.sin = Math.sin(camera.rotation);
    frameTransform.cx = canvasEl.clientWidth / 2;
    frameTransform.cy = canvasEl.clientHeight / 2;
    frameTransform.scale = camera.scale;
    frameTransform.camX = camera.x;
    frameTransform.camY = camera.y;
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
    document.getElementById("zoom-indicator").textContent = scale >= 0.01 ? Math.round(scale * 100) + "%" : scale.toExponential(1);
    const deg = Math.round(camera.rotation * 180 / Math.PI);
    document.getElementById("rotation-indicator").textContent = deg + "°";
  }

  function setupCanvas() {
    canvasEl = document.getElementById("draw-surface");
    toolbarEl = document.getElementById("toolbar");
    ctx = canvasEl.getContext("2d");
    resize();
    window.addEventListener("resize", resize);
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const rect = canvasEl.getBoundingClientRect();
    canvasEl.width = Math.round(rect.width * dpr);
    canvasEl.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }

  function getViewportAABB() {
    const w = canvasEl.clientWidth;
    const h = canvasEl.clientHeight;
    
    const cos = Math.cos(-camera.rotation);
    const sin = Math.sin(-camera.rotation);
    
    // Top Left (0, 0)
    let px = -w / 2;
    let py = -h / 2;
    let x1 = (px * cos - py * sin) / camera.scale + camera.x;
    let y1 = (px * sin + py * cos) / camera.scale + camera.y;
    
    // Top Right (w, 0)
    px = w / 2; py = -h / 2;
    let x2 = (px * cos - py * sin) / camera.scale + camera.x;
    let y2 = (px * sin + py * cos) / camera.scale + camera.y;
    
    // Bottom Left (0, h)
    px = -w / 2; py = h / 2;
    let x3 = (px * cos - py * sin) / camera.scale + camera.x;
    let y3 = (px * sin + py * cos) / camera.scale + camera.y;
    
    // Bottom Right (w, h)
    px = w / 2; py = h / 2;
    let x4 = (px * cos - py * sin) / camera.scale + camera.x;
    let y4 = (px * sin + py * cos) / camera.scale + camera.y;
    
    viewportBounds.minX = Math.min(x1, x2, x3, x4);
    viewportBounds.maxX = Math.max(x1, x2, x3, x4);
    viewportBounds.minY = Math.min(y1, y2, y3, y4);
    viewportBounds.maxY = Math.max(y1, y2, y3, y4);
    
    return viewportBounds;
  }

  function drawGrid(c) {
    const w = canvasEl.clientWidth;
    const h = canvasEl.clientHeight;
    let spacing = 100;
    while (spacing * camera.scale < 30) spacing *= 2;
    while (spacing * camera.scale > 60) spacing /= 2;

    c.save();
    c.fillStyle = "#d0d0d8";
    
    const bounds = getViewportAABB();
    const startX = Math.floor(bounds.minX / spacing) * spacing;
    const startY = Math.floor(bounds.minY / spacing) * spacing;
    
    const t = frameTransform;
    
    for (let wx = startX; wx <= bounds.maxX; wx += spacing) {
      for (let wy = startY; wy <= bounds.maxY; wy += spacing) {
        const dx = wx - t.camX;
        const dy = wy - t.camY;
        const sx = (dx * t.cos - dy * t.sin) * t.scale + t.cx;
        const sy = (dx * t.sin + dy * t.cos) * t.scale + t.cy;
        
        c.beginPath();
        c.arc(sx, sy, 1.5, 0, Math.PI * 2);
        c.fill();
      }
    }
    c.restore();
  }

  function drawStrokeOn(c, stroke) {
    if (!stroke.points || stroke.points.length === 0) return;
    const screenWidth = (stroke.width || 4) * camera.scale;
    if (screenWidth < 0.1) return;

    c.save();
    c.lineCap = "round";
    c.lineJoin = "round";
    c.strokeStyle = stroke.isEraser ? "#fbfaf7" : (stroke.color || "#1a1a2e");
    c.fillStyle = stroke.isEraser ? "#fbfaf7" : (stroke.color || "#1a1a2e");
    c.lineWidth = screenWidth;

    const t = frameTransform;

    if (stroke.points.length === 1) {
      const dx = stroke.points[0].x - t.camX;
      const dy = stroke.points[0].y - t.camY;
      const sx = (dx * t.cos - dy * t.sin) * t.scale + t.cx;
      const sy = (dx * t.sin + dy * t.cos) * t.scale + t.cy;
      
      c.beginPath();
      c.arc(sx, sy, c.lineWidth / 2, 0, Math.PI * 2);
      c.fill();
    } else {
      c.beginPath();
      
      let dx = stroke.points[0].x - t.camX;
      let dy = stroke.points[0].y - t.camY;
      let sx = (dx * t.cos - dy * t.sin) * t.scale + t.cx;
      let sy = (dx * t.sin + dy * t.cos) * t.scale + t.cy;
      c.moveTo(sx, sy);

      for (let i = 1; i < stroke.points.length - 1; i++) {
        dx = stroke.points[i].x - t.camX;
        dy = stroke.points[i].y - t.camY;
        const p1x = (dx * t.cos - dy * t.sin) * t.scale + t.cx;
        const p1y = (dx * t.sin + dy * t.cos) * t.scale + t.cy;

        dx = stroke.points[i + 1].x - t.camX;
        dy = stroke.points[i + 1].y - t.camY;
        const p2x = (dx * t.cos - dy * t.sin) * t.scale + t.cx;
        const p2y = (dx * t.sin + dy * t.cos) * t.scale + t.cy;

        c.quadraticCurveTo(p1x, p1y, (p1x + p2x) / 2, (p1y + p2y) / 2);
      }
      
      const lastIdx = stroke.points.length - 1;
      dx = stroke.points[lastIdx].x - t.camX;
      dy = stroke.points[lastIdx].y - t.camY;
      const lastX = (dx * t.cos - dy * t.sin) * t.scale + t.cx;
      const lastY = (dx * t.sin + dy * t.cos) * t.scale + t.cy;
      
      c.lineTo(lastX, lastY);
      c.stroke();
    }
    c.restore();
  }

  let renderScheduled = false;
  function redraw() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(function() {
      renderScheduled = false;
      if (!ctx) return;
      
      updateFrameTransform();
      
      const w = canvasEl.clientWidth;
      const h = canvasEl.clientHeight;
      
      ctx.clearRect(0, 0, w, h);
      drawGrid(ctx);
      
      if (canvasData) {
        const viewBox = getViewportAABB();
        const visibleStrokes = strokeTree ? strokeTree.retrieve(viewBox) : canvasData.strokes;

        for (let i = 0; i < visibleStrokes.length; i++) {
          const s = visibleStrokes[i];
          if (s.points.length > 0) {
            const originScale = s.originScale || 1.0;
            if (camera.scale < originScale * CULL_FACTOR) continue;
          }
          drawStrokeOn(ctx, s);
        }
      }
      
      if (gesture && gesture.type === "draw" && screenPointCount > 0) {
        ctx.save();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = currentStroke.isEraser ? "#fbfaf7" : currentStroke.color;
        ctx.lineWidth = currentStroke.width * camera.scale;
        ctx.beginPath();
        
        for (let i = 0; i < screenPointCount; i++) {
          const sx = screenPoints[i * 2];
          const sy = screenPoints[i * 2 + 1];
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }
        ctx.stroke();
        ctx.restore();
      }
    });
  }

  // --- SAVING ---
  function requestSave() {
    if (!canvasData) return;
    canvasData.modifiedAt = Date.now();
    pendingSave = canvasData;

    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function() { executeSave(); }, 5000);
  }

  function executeSave() {
    if (!pendingSave || saveInFlight) return;
    saveInFlight = true;
    const overlay = document.getElementById("saving-overlay");
    if (overlay) overlay.classList.add("visible");
    
    const snapshot = JSON.parse(JSON.stringify(pendingSave));
    pendingSave = null;
    
    setTimeout(function() {
      Store.save(snapshot).then(function () {
        saveInFlight = false;
        if (overlay) overlay.classList.remove("visible");
        if (pendingSave) {
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = setTimeout(executeSave, 5000);
        }
      }).catch(function (err) {
        saveInFlight = false;
        if (overlay) overlay.classList.remove("visible");
        if (window.showError) window.showError("Could not save: " + err);
      });
    }, 150); 
  }

  // --- 1. PEN INPUT ---
  function penDown(e) {
    if (e.pointerType !== "pen" && e.pointerType !== "mouse") return;
    e.preventDefault();

    isPenActive = true;
    if (canvasEl.setPointerCapture) {
      try { canvasEl.setPointerCapture(e.pointerId); } catch (err) { }
    }
    if (toolbarEl) toolbarEl.style.pointerEvents = "none";

    const rect = canvasEl.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    strokeOriginCamera = {
      x: camera.x, y: camera.y,
      scale: camera.scale, rotation: camera.rotation
    };

    currentStroke = {
      id: Store.uuid(),
      points: [],
      color: currentColor,
      width: currentSize / camera.scale,
      isEraser: currentTool === "eraser",
      originScale: camera.scale
    };
    gesture = { type: "draw" };

    screenPointCount = 0;
    screenPoints[screenPointCount * 2] = sx;
    screenPoints[screenPointCount * 2 + 1] = sy;
    screenPointCount++;

    redraw();
  }

  function penMove(e) {
    if (e.pointerType !== "pen" && e.pointerType !== "mouse") return;
    if (!currentStroke || !gesture || gesture.type !== "draw") return;
    if (screenPointCount >= MAX_SCREEN_POINTS) return;

    const rect = canvasEl.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    const lastX = screenPoints[(screenPointCount - 1) * 2];
    const lastY = screenPoints[(screenPointCount - 1) * 2 + 1];

    const dx = sx - lastX;
    const dy = sy - lastY;
    if ((dx * dx) + (dy * dy) < 2.25) return;

    screenPoints[screenPointCount * 2] = sx;
    screenPoints[screenPointCount * 2 + 1] = sy;
    screenPointCount++;

    redraw();
  }

  function penUp(e) {
    if (e.pointerType !== "pen" && e.pointerType !== "mouse") return;

    isPenActive = false;
    if (canvasEl.releasePointerCapture) {
      try { canvasEl.releasePointerCapture(e.pointerId); } catch (err) { }
    }
    if (toolbarEl) toolbarEl.style.pointerEvents = "auto";

    if (gesture && gesture.type === "draw" && currentStroke) {
      if (strokeOriginCamera && screenPointCount > 0) {
        const c = strokeOriginCamera;
        const cos = Math.cos(-c.rotation);
        const sin = Math.sin(-c.rotation);
        const cx = canvasEl.clientWidth / 2;
        const cy = canvasEl.clientHeight / 2;

        for (let i = 0; i < screenPointCount; i++) {
          const px = screenPoints[i * 2] - cx;
          const py = screenPoints[i * 2 + 1] - cy;
          currentStroke.points.push({
            x: (px * cos - py * sin) / c.scale + c.x,
            y: (px * sin + py * cos) / c.scale + c.y
          });
        }
      }

      if (currentStroke.points.length > 0 && canvasData) {
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
        requestSave();
      }

      currentStroke = null;
      gesture = null;
      strokeOriginCamera = null;
      redraw();
    }
  }

  // --- 2. TOUCH INPUT ---
  function touchStart(e) {
    if (isPenActive) return;
    if (gesture && gesture.type === "draw") return;

    const rect = canvasEl.getBoundingClientRect();
    
    if (e.touches.length === 1) {
      const t = e.touches[0];
      gesture = { type: "pending_pan", startX: t.clientX - rect.left, startY: t.clientY - rect.top };
    } else if (e.touches.length === 2) {
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const dx = (t1.clientX - rect.left) - (t0.clientX - rect.left);
      const dy = (t1.clientY - rect.top) - (t0.clientY - rect.top);
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const angle = Math.atan2(dy, dx);
      const midX = (t0.clientX - rect.left + t1.clientX - rect.left) / 2;
      const midY = (t0.clientY - rect.top + t1.clientY - rect.top) / 2;
      const startWorld = screenToWorld(midX, midY);
      
      gesture = {
        type: "pinch", startDist: dist, startAngle: angle,
        startScale: camera.scale, startRotation: camera.rotation,
        startMid: { x: midX, y: midY }, startWorld: startWorld
      };
    }
  }

  function touchMove(e) {
    if (isPenActive) return;
    if (gesture && gesture.type === "draw") return;
    if (!gesture) return;

    if (gesture.type === "pan" || gesture.type === "pinch") {
      e.preventDefault(); 
    }

    const rect = canvasEl.getBoundingClientRect();

    if (gesture.type === "pending_pan" && e.touches.length === 1) {
      const t = e.touches[0];
      const localX = t.clientX - rect.left;
      const localY = t.clientY - rect.top;
      
      const dx = localX - gesture.startX;
      const dy = localY - gesture.startY;
      
      if ((dx * dx) + (dy * dy) > 225) {
        gesture = { type: "pan", lastX: localX, lastY: localY };
      }
    } else if (gesture.type === "pan" && e.touches.length === 1) {
      const t = e.touches[0];
      const localX = t.clientX - rect.left;
      const localY = t.clientY - rect.top;
      
      const dx = localX - gesture.lastX;
      const dy = localY - gesture.lastY;
      const cos = Math.cos(-camera.rotation);
      const sin = Math.sin(-camera.rotation);
      
      camera.x -= (dx * cos - dy * sin) / camera.scale;
      camera.y -= (dx * sin + dy * cos) / camera.scale;
      gesture.lastX = localX;
      gesture.lastY = localY;
      redraw();
    } else if (gesture.type === "pinch" && e.touches.length >= 2) {
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const dx = (t1.clientX - rect.left) - (t0.clientX - rect.left);
      const dy = (t1.clientY - rect.top) - (t0.clientY - rect.top);
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const currentAngle = Math.atan2(dy, dx);
      const midX = (t0.clientX - rect.left + t1.clientX - rect.left) / 2;
      const midY = (t0.clientY - rect.top + t1.clientY - rect.top) / 2;
      const ratio = dist / gesture.startDist;
      
      let newScale = gesture.startScale * ratio;
      
      if (!zoomLocked) {
        newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
      } else {
        newScale = gesture.startScale;
      }

      let newRotation = gesture.startRotation;
      
      if (!rotationLocked && Date.now() >= rotationSnapHoldUntil) {
        newRotation = gesture.startRotation + (currentAngle - gesture.startAngle);
      }
      
      const mdx = midX - canvasEl.clientWidth / 2;
      const mdy = midY - canvasEl.clientHeight / 2;
      const cosNeg = Math.cos(-newRotation);
      const sinNeg = Math.sin(-newRotation);
      
      camera.scale = newScale;
      camera.rotation = newRotation;
      camera.x = gesture.startWorld.x - (mdx * cosNeg - mdy * sinNeg) / newScale;
      camera.y = gesture.startWorld.y - (mdx * sinNeg + mdy * cosNeg) / newScale;
      
      updateIndicators();
      redraw();
    }
  }

  function touchEnd(e) {
    if (isPenActive) return;
    if (gesture && gesture.type === "draw") return;
    if (!gesture) return;

    if (e.touches.length === 0) {
      if (gesture.type === "pinch") {
        if (!rotationLocked && Math.abs(camera.rotation) < 5 * Math.PI / 180) {
          camera.rotation = 0;
          rotationSnapHoldUntil = Date.now() + 1000;
          updateIndicators();
        }
      }
      gesture = null;
      redraw();
    } else if (e.touches.length === 1 && gesture.type === "pinch") {
      const t = e.touches[0];
      const r = canvasEl.getBoundingClientRect();
      gesture = { type: "pending_pan", startX: t.clientX - r.left, startY: t.clientY - r.top };
    }
  }

  function centerOnContent() {
    if (!canvasData || canvasData.strokes.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    
    canvasData.strokes.forEach(function(s) {
      (s.points || []).forEach(function(p) {
        if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
      });
    });

    if (isFinite(minX) && isFinite(minY)) {
      camera.x = (minX + maxX) / 2;
      camera.y = (minY + maxY) / 2;
      camera.rotation = 0;
      const w = canvasEl.clientWidth;
      const h = canvasEl.clientHeight;
      const contentW = maxX - minX + 400;
      const contentH = maxY - minY + 400;
      let newScale = Math.min(w / contentW, h / contentH);
      newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
      camera.scale = newScale;
      updateIndicators();
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
      this.classList.toggle('active', rotationLocked);
    });

    var zoomLockBtn = document.getElementById('zoom-lock-btn');
    zoomLockBtn.addEventListener('click', function() {
      zoomLocked = !zoomLocked;
      this.textContent = zoomLocked ? 'ZOOM 🔒' : 'ZOOM 🔓';
      this.classList.toggle('active', zoomLocked);
    });
  }

  function setupEvents() {
    canvasEl.addEventListener("contextmenu", function(ev) { ev.preventDefault(); });
    canvasEl.addEventListener("selectstart", function(ev) { ev.preventDefault(); });
    document.addEventListener("contextmenu", function(ev) { ev.preventDefault(); });
    document.addEventListener("selectstart", function(ev) { ev.preventDefault(); });

    canvasEl.addEventListener("pointerdown", penDown);
    canvasEl.addEventListener("pointermove", penMove);
    canvasEl.addEventListener("pointerup", penUp);
    canvasEl.addEventListener("pointercancel", penUp);

    canvasEl.addEventListener("touchstart", touchStart, { passive: true });
    canvasEl.addEventListener("touchmove", touchMove, { passive: false });
    canvasEl.addEventListener("touchend", touchEnd, { passive: true });
    canvasEl.addEventListener("touchcancel", touchEnd, { passive: true });
    
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
      rebuildQuadtree();
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
