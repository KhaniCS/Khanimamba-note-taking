(function () {
  "use strict";

  const { rotX, rotY } = window.Geo;

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
      this._invRotation = null; // cache key
    }

    markDirty() { this.dirty = true; this.panDirty = true; }
    markPanDirty() { this.panDirty = true; }

    setPosition(x, y, scale, rotation) {
      this.x = x; this.y = y; this.scale = scale; this.rotation = rotation;
      this.markDirty();
    }

    // CACHED: recompute only when rotation actually changes
    _invRot() {
      if (this._invRotation !== this.rotation) {
        this._inv.cos = Math.cos(-this.rotation);
        this._inv.sin = Math.sin(-this.rotation);
        this._invRotation = this.rotation;
      }
      return this._inv;
    }

    // THE one place that turns a screen-space offset (pixels from the view centre,
    // or a drag distance) into a world-space offset: undo the rotation, undo the zoom.
    // Pan, zoom, toWorld and getVisibleBounds all use these two.
    _worldDX(px, py) { const r = this._invRot(); return rotX(px, py, r.cos, r.sin) / this.scale; }
    _worldDY(px, py) { const r = this._invRot(); return rotY(px, py, r.cos, r.sin) / this.scale; }

    pan(dx, dy) {
      this.x -= this._worldDX(dx, dy);
      this.y -= this._worldDY(dx, dy);
      this.markPanDirty();
    }

    zoomAt(sx, sy, newScale, newRot, cx, cy) {
      const worldMid = this.toWorld(sx, sy, cx, cy);

      this.scale = newScale;
      this.rotation = newRot;
      this.markDirty();

      // keep the world point under the fingers fixed on screen
      const mdx = sx - cx, mdy = sy - cy;
      this.x = worldMid.x - this._worldDX(mdx, mdy);
      this.y = worldMid.y - this._worldDY(mdx, mdy);
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
        // world origin of the camera -> view centre
        this.tx = -rotX(this.x, this.y, this.a, this.b) + this.cx;
        this.ty = -rotY(this.x, this.y, this.a, this.b) + this.cy;
        this.panDirty = false;
      }
    }

    toWorld(sx, sy, cx, cy) {
      const px = sx - cx, py = sy - cy;
      return {
        x: this._worldDX(px, py) + this.x,
        y: this._worldDY(px, py) + this.y
      };
    }

    getVisibleBounds(w, h, cx, cy) {
      const corners = [
        -cx, -cy,   w - cx, -cy,
        -cx, h - cy, w - cx, h - cy
      ];

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

      for (let i = 0; i < 8; i += 2) {
        const wx = this.x + this._worldDX(corners[i], corners[i + 1]);
        const wy = this.y + this._worldDY(corners[i], corners[i + 1]);
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
      }

      return { minX, maxX, minY, maxY };
    }
  }

  window.Camera = Camera;
})();
