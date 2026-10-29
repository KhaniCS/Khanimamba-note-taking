(function () {
  "use strict";

  function wireUp() {
    var btn = document.getElementById("new-canvas-btn");
    if (!btn) {
      if (window.showError) window.showError("Could not find the + button in the HTML.");
      return;
    }
    
    btn.addEventListener("click", function () {
      if (window.showError) {
        window.showError("THE BUTTON WAS TAPPED!");
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireUp);
  } else {
    wireUp();
  }
})();
