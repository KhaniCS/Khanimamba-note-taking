(function () {
  "use strict";

  class Camera {
    constructor() {
      this.x = 0;
      this.y = 0;
      this.scale = 1;
      this.rotation = 0;

      this.a = 1;
      this.b = 0;
      this.tx = 0;
      this.ty = 0;

      this.dirty = true;
      this.panDirty = true;
      this.cx = 0;
      this.cy = 0;

      this._inv = { cos: 1, sin: 0 };
    }

    markDirty() { this.dirty = true; this.panDirty = true; }
    markPanDirty() { this.panDirty = true; }

    setPosition(x, y, scale, rotation) {
      this.x = x; this.y = y; this.scale = scale; this.rotation = rotation;
      this.markDirty();
    }

    pan(dx, dy) {
      const r = this._invRot();
      this.x -= (dx * r.cos - dy * r.sin) / this.scale;
      this.y -= (dx * r.sin + dy * r.cos) / this.scale;
      this.markPanDirty();
    }

    zoomAt(sx, sy, newScale, newRot, cx, cy) {
      const worldMid = this.toWorld(sx, sy, cx, cy);
      this.scale = newScale;
      this.rotation = newRot;
      this.markDirty();

      const r = this._invRot();
      const mdx = sx - cx, mdy = sy - cy;
      this.x = worldMid.x - (mdx * r.cos - mdy * r.sin) / newScale;
      this.y = worldMid.y - (mdx * r.sin + mdy * r.cos) / newScale;
    }

    // THE EXTRACTION: one place for the cos/sin(-rotation) pair
    _invRot() {
      this._inv.cos = Math.cos(-this.rotation);
      this._inv.sin = Math.sin(-this.rotation);
      return this._inv;
    }

    updateMatrix(cx, cy) {
      this.cx = cx;
      this.cy = cy;

      if (this.dirty) {
        const cos = Math.cos(this.rotation);
        const sin = Math.sin(this.rotation);
        this.a = cos * this.scale;
        this.b = sin * this.scale;
        this.dirty = false;
      }

      if (this.panDirty) {
        this.tx = -this.x * this.a + this.y * this.b + this.cx;
        this.ty = -this.x * this.b - this.y * this.a + this.cy;
        this.panDirty = false;
      }
    }

    toWorld(sx, sy, cx, cy) {
      const r = this._invRot();
      const px = sx - cx, py = sy - cy;
      return {
        x: (px * r.cos - py * r.sin) / this.scale + this.x,
        y: (px * r.sin + py * r.cos) / this.scale + this.y
      };
    }

    getVisibleBounds(w, h, cx, cy) {
      const inv = 1 / this.scale;
      const r = this._invRot();

      const corners = [
        { x: -cx, y: -cy }, { x: w - cx, y: -cy },
        { x: -cx, y: h - cy }, { x: w - cx, y: h - cy }
      ];

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < 4; i++) {
        const c = corners[i];
        const wx = this.x + (c.x * r.cos - c.y * r.sin) * inv;
        const wy = this.y + (c.x * r.sin + c.y * r.cos) * inv;
        minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
        minY = Math.min(minY, wy); maxY = Math.max(maxY, wy);
      }
      return { minX, maxX, minY, maxY };
    }
  }

  window.Camera = Camera;
})();
