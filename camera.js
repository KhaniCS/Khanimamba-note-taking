(function () {
  "use strict";

  class Camera {
    constructor() {
      this.x = 0;
      this.y = 0;
      this.scale = 1;
      this.rotation = 0;

      // Matrix cache
      this.a = 1;
      this.b = 0;
      this.tx = 0;
      this.ty = 0;

      this.dirty = true;
      this.panDirty = true;
      this.cx = 0;
      this.cy = 0;
    }

    // Full rebuild — needed when rotation or scale changes
    markDirty() {
      this.dirty = true;
      this.panDirty = true;
    }

    // Position-only rebuild — during panning. NO TRIG.
    markPanDirty() {
      this.panDirty = true;
    }

    updateMatrix(cx, cy) {
      this.cx = cx;
      this.cy = cy;

      // Only recalculate cos/sin if rotation/scale actually changed
      if (this.dirty) {
        const cos = Math.cos(this.rotation);
        const sin = Math.sin(this.rotation);
        this.a = cos * this.scale;
        this.b = sin * this.scale;
        this.dirty = false;
      }

      // Always update translation when pan is dirty (no trig, just mult + add)
      if (this.panDirty) {
        this.tx = -this.x * this.a + this.y * this.b + this.cx;
        this.ty = -this.x * this.b - this.y * this.a + this.cy;
        this.panDirty = false;
      }
    }

    // Convert screen to world using the inverse matrix
    toWorld(sx, sy, cx, cy) {
      const px = sx - cx;
      const py = sy - cy;
      const cos = Math.cos(-this.rotation);
      const sin = Math.sin(-this.rotation);
      return {
        x: (px * cos - py * sin) / this.scale + this.x,
        y: (px * sin + py * cos) / this.scale + this.y
      };
    }

    // Get the visible bounds in world space
    getVisibleBounds(w, h, cx, cy) {
      const invScale = 1 / this.scale;
      const cos = Math.cos(-this.rotation);
      const sin = Math.sin(-this.rotation);

      const p1x = -cx, p1y = -cy;
      const p2x = w - cx, p2y = -cy;
      const p3x = -cx, p3y = h - cy;
      const p4x = w - cx, p4y = h - cy;

      const minX = this.x + Math.min(
        (p1x * cos - p1y * sin) * invScale,
        (p2x * cos - p2y * sin) * invScale,
        (p3x * cos - p3y * sin) * invScale,
        (p4x * cos - p4y * sin) * invScale
      );
      const maxX = this.x + Math.max(
        (p1x * cos - p1y * sin) * invScale,
        (p2x * cos - p2y * sin) * invScale,
        (p3x * cos - p3y * sin) * invScale,
        (p4x * cos - p4y * sin) * invScale
      );
      const minY = this.y + Math.min(
        (p1x * sin + p1y * cos) * invScale,
        (p2x * sin + p2y * cos) * invScale,
        (p3x * sin + p3y * cos) * invScale,
        (p4x * sin + p4y * cos) * invScale
      );
      const maxY = this.y + Math.max(
        (p1x * sin + p1y * cos) * invScale,
        (p2x * sin + p2y * cos) * invScale,
        (p3x * sin + p3y * cos) * invScale,
        (p4x * sin + p4y * cos) * invScale
      );

      return { minX, maxX, minY, maxY };
    }
  }

  window.Camera = Camera;
})();
