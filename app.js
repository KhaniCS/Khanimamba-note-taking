(function () {
  "use strict";

  function wireUp() {
    var btn = document.getElementById("new-canvas-btn");
    if (!btn) {
      window.showError("Could not find the + button in the HTML.");
      return;
    }
    
    btn.addEventListener("click", function () {
      alert("THE BUTTON WAS TAPPED!");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireUp);
  } else {
    wireUp();
  }
})();
