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
      // 1. THE DATA TABLE
      const buttonGroups = [
        { selector: '.tool-btn[data-tool]', property: 'currentTool', attribute: 'data-tool' },
        { selector: '.size-btn', property: 'currentSize', attribute: 'data-size', isNumber: true },
        { selector: '.color-btn', property: 'currentColor', attribute: 'data-color' }
      ];

      // 2. ONE LOOP FOR ALL GROUPS
      buttonGroups.forEach(group => {
        document.querySelectorAll(group.selector).forEach(btn => {
          btn.addEventListener('click', () => {
            document.querySelectorAll(group.selector).forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            const val = btn.getAttribute(group.attribute);
            this[group.property] = group.isNumber ? parseInt(val, 10) : val;
          });
        });
      });

      document.getElementById('lost-btn').addEventListener('click', onCenter);

      // 3. THE TOGGLE DATA TABLE
      const lockButtons = [
        { id: 'rotate-lock-btn', property: 'rotationLocked', onLabel: 'ROT 🔒', offLabel: 'ROT 🔓', callback: onToggleRotation },
        { id: 'zoom-lock-btn', property: 'zoomLocked', onLabel: 'ZOOM 🔒', offLabel: 'ZOOM 🔓', callback: onToggleZoom }
      ];

      // 4. ONE LOOP FOR ALL TOGGLES
      lockButtons.forEach(config => {
        const btn = document.getElementById(config.id);
        if (!btn) return;
        btn.addEventListener('click', () => {
          this[config.property] = !this[config.property];
          btn.textContent = this[config.property] ? config.onLabel : config.offLabel;
          btn.classList.toggle('active', this[config.property]);
          if (config.callback) config.callback();
        });
      });
    }
  }

  window.Toolbar = Toolbar;
})();
