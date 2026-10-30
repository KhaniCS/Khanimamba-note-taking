(function () {
  "use strict";

  class PanBuffer {
    constructor(camera, canvasEl) {
      this.camera = camera;
      this.canvasEl = canvasEl;
      this.offsetX = 0;
      this.offsetY = 0;
      this.marginRatio = 0.20; // 20% margin
    }

    addDelta(dx, dy, w, h) {
      this.offsetX += dx;
      this.offsetY += dy;
      
      const maxMarginX = w * this.marginRatio;
      const maxMarginY = h * this.marginRatio;

      if (Math.abs(this.offsetX) > maxMarginX || Math.abs(this.offsetY) > maxMarginY) {
        return true; // Requires re-render
      }

      this.canvasEl.style.transform = "translate(" + this.offsetX + "px, " + this.offsetY + "px)";
      return false; // CSS transform is enough
    }

    reset() {
      this.offsetX = 0;
      this.offsetY = 0;
      this.canvasEl.style.transform = "translate(0px, 0px)";
    }
  }

  window.PanBuffer = PanBuffer;
})();
