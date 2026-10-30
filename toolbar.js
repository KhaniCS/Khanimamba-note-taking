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
      // 1. Collapse the 3 button groups into one helper
      const wireGroup = (selector, applyValue) => {
        document.querySelectorAll(selector).forEach((btn) => {
          btn.addEventListener('click', () => {
            document.querySelectorAll(selector).forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            applyValue(btn);
          });
        });
      };

      wireGroup('.tool-btn[data-tool]', btn => { this.currentTool = btn.getAttribute('data-tool'); });
      wireGroup('.size-btn', btn => { this.currentSize = parseInt(btn.getAttribute('data-size'), 10); });
      wireGroup('.color-btn', btn => { this.currentColor = btn.getAttribute('data-color'); });

      document.getElementById('lost-btn').addEventListener('click', onCenter);

      // 2. Collapse the 2 lock toggles into one helper
      const wireToggle = (id, activeKey, labelOn, labelOff, onToggle) => {
        const btn = document.getElementById(id);
        btn.addEventListener('click', () => {
          this[activeKey] = !this[activeKey];
          btn.textContent = this[activeKey] ? labelOn : labelOff;
          btn.classList.toggle('active', this[activeKey]);
          if (onToggle) onToggle();
        });
      };

      wireToggle('rotate-lock-btn', 'rotationLocked', 'ROT 🔒', 'ROT 🔓', onToggleRotation);
      wireToggle('zoom-lock-btn', 'zoomLocked', 'ZOOM 🔒', 'ZOOM 🔓', onToggleZoom);
    }
  }

  window.Toolbar = Toolbar;
})();
