(function () {
  "use strict";

  class Toolbar {
    constructor() {
      this.currentTool = "pen";
      this.currentSize = 4;
      this.currentColor = "#1a1a2e";
      this.rotationLocked = false;
      this.zoomLocked = false;
      this.rotationSnapHoldUntil = 0;
    }

    wire(onCenter, onToggleRotation, onToggleZoom) {
      document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.currentTool = btn.getAttribute('data-tool');
        });
      });

      document.querySelectorAll('.size-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.currentSize = parseInt(btn.getAttribute('data-size'), 10);
        });
      });

      document.querySelectorAll('.color-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.currentColor = btn.getAttribute('data-color');
        });
      });

      document.getElementById('lost-btn').addEventListener('click', onCenter);

      const rotBtn = document.getElementById('rotate-lock-btn');
      rotBtn.addEventListener('click', () => {
        this.rotationLocked = !this.rotationLocked;
        rotBtn.textContent = this.rotationLocked ? 'ROT 🔒' : 'ROT 🔓';
        rotBtn.classList.toggle('active', this.rotationLocked);
        onToggleRotation();
      });

      const zoomBtn = document.getElementById('zoom-lock-btn');
      zoomBtn.addEventListener('click', () => {
        this.zoomLocked = !this.zoomLocked;
        zoomBtn.textContent = this.zoomLocked ? 'ZOOM 🔒' : 'ZOOM 🔓';
        zoomBtn.classList.toggle('active', this.zoomLocked);
        onToggleZoom();
      });
    }
  }

  window.Toolbar = Toolbar;
})();
