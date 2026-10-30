(function () {
  "use strict";

  // ------------------------------------------------------------------
  // Geo: the shared maths for the canvas. Every formula that used to be
  // copy-pasted in several places lives here exactly once.
  // All functions are pure and small (no object creation), so they are safe
  // to call inside the hot drawing loops.
  // ------------------------------------------------------------------

  const DEG = Math.PI / 180;                 // multiply degrees by this to get radians

  // ---- small scalar helpers ----------------------------------------
  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
  const toDeg = (rad) => rad / DEG;
  const dist2 = (dx, dy) => dx * dx + dy * dy;           // squared distance (no sqrt)

  // ---- 2D rotation (the one formula behind every transform) --------
  // Rotates the point (x, y) by an angle whose cos/sin you pass in.
  //   world -> screen:  rotX(x, y, a, b) + tx      (a = cos*scale, b = sin*scale)
  //   screen -> world:  rotX(px, py, cosInv, sinInv) / scale + cameraX
  const rotX = (x, y, cos, sin) => x * cos - y * sin;
  const rotY = (x, y, cos, sin) => x * sin + y * cos;

  // ---- axis-aligned bounding boxes: { minX, minY, maxX, maxY } -----
  const emptyBounds = () => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

  function extendBounds(b, x, y) {
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y;
    if (y > b.maxY) b.maxY = y;
    return b;
  }

  function mergeBounds(a, b) {
    if (!b) return a;
    extendBounds(a, b.minX, b.minY);
    extendBounds(a, b.maxX, b.maxY);
    return a;
  }

  function boundsOfPoints(points) {
    if (!points || points.length === 0) return null;
    const b = emptyBounds();
    for (let i = 0; i < points.length; i++) extendBounds(b, points[i].x, points[i].y);
    return b;
  }

  // Do two boxes overlap? `pad` grows box `a` on every side (e.g. half a pen width).
  const boundsOverlap = (a, b, pad = 0) =>
    !(a.maxX + pad < b.minX || a.minX - pad > b.maxX ||
      a.maxY + pad < b.minY || a.minY - pad > b.maxY);

  // ---- grid spacing -------------------------------------------------
  // Picks base * 2^k so that (spacing * scale) lands in [minPx, 2*minPx).
  // Replaces two while-loops with one equation.
  function gridSpacing(base, scale, minPx) {
    return base * Math.pow(2, Math.ceil(Math.log2(minPx / (base * scale))));
  }

  // ---- "zoom to fit" ------------------------------------------------
  // The scale at which a box of (w x h) plus `pad` of breathing room fits a view.
  const fitScale = (w, h, viewW, viewH, pad) =>
    Math.min(viewW / (w + pad), viewH / (h + pad));

  window.Geo = {
    DEG, clamp, toDeg, dist2, rotX, rotY,
    emptyBounds, extendBounds, mergeBounds, boundsOfPoints, boundsOverlap,
    gridSpacing, fitScale
  };
})();
