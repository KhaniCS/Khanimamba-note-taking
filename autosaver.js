(function () {
  "use strict";

  class AutoSaver {
    constructor(store, delayMs) {
      this.Store = store;
      this.delayMs = delayMs;
      this.timer = null;
      this.pendingData = null;
      this.isSaving = false;
    }

    schedule(data) {
      this.pendingData = data;
      if (this.timer) clearTimeout(this.timer);
      
      this.timer = setTimeout(() => {
        this.execute();
      }, this.delayMs);
    }

    execute() {
      if (!this.pendingData || this.isSaving) return;
      
      this.isSaving = true;
      const overlay = document.getElementById("saving-overlay");
      if (overlay) overlay.classList.add("visible");
      
      // Deep clone to avoid race conditions
      const snapshot = JSON.parse(JSON.stringify(this.pendingData));
      this.pendingData = null;
      
      setTimeout(() => {
        this.Store.save(snapshot).then(() => {
          this.isSaving = false;
          if (overlay) overlay.classList.remove("visible");
          
          if (this.pendingData) {
            if (this.timer) clearTimeout(this.timer);
            this.timer = setTimeout(() => this.execute(), this.delayMs);
          }
        }).catch((err) => {
          this.isSaving = false;
          if (overlay) overlay.classList.remove("visible");
          if (window.showError) window.showError("Could not save: " + err);
        });
      }, 150);
    }
  }

  window.AutoSaver = AutoSaver;
})();
