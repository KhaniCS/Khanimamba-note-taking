(function () {
  "use strict";

  class PanBuffer {
    constructor(camera, canvasEl) {
      this.camera = camera;
      this.canvasEl = canvasEl;
      this.offsetX = 0;
      this.offsetY = 0;
      this.marginRatio = 0.20; // 20% margin

      // PERF: tell the browser this canvas will be moved around, so it keeps it on
      // its own GPU layer and slides it without repainting anything.
      this.canvasEl.style.willChange = "transform";
    }

    addDelta(dx, dy, w, h) {
      this.offsetX += dx;
      this.offsetY += dy;

      const maxMarginX = w * this.marginRatio;
      const maxMarginY = h * this.marginRatio;

      if (Math.abs(this.offsetX) > maxMarginX || Math.abs(this.offsetY) > maxMarginY) {
        return true; // Requires re-render
      }

      // translate3d (instead of translate) makes sure the move is done on the GPU
      this.canvasEl.style.transform =
        "translate3d(" + this.offsetX + "px, " + this.offsetY + "px, 0)";
      return false; // CSS transform is enough
    }

    reset() {
      this.offsetX = 0;
      this.offsetY = 0;
      this.canvasEl.style.transform = "translate3d(0px, 0px, 0)";
    }
  }

  window.PanBuffer = PanBuffer;
})();
