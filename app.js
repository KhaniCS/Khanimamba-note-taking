(function () {
  "use strict";

  const Store = window.Store;

  function formatDate(ms) {
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  let undoBanner = null;
  let undoTimer = null;

  function showUndoBanner(canvas) {
    if (!undoBanner) {
      undoBanner = document.createElement("div");
      undoBanner.id = "undo-banner";
      undoBanner.style.cssText =
        "position:fixed;bottom:24px;left:24px;right:24px;max-width:420px;margin:0 auto;" +
        "background:#1d1d1f;color:#fff;padding:14px 16px;border-radius:12px;" +
        "display:flex;justify-content:space-between;align-items:center;" +
        "font-size:15px;box-shadow:0 8px 24px rgba(0,0,0,0.2);z-index:200;";
      document.body.appendChild(undoBanner);
    }
    undoBanner.innerHTML = "";

    const label = document.createElement("span");
    label.textContent = "Deleted \"" + (canvas.title || "Untitled") + "\"";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Undo";
    btn.style.cssText =
      "background:#007aff;color:#fff;border:none;padding:8px 14px;" +
      "border-radius:8px;font-size:15px;cursor:pointer;margin-left:12px;";

    btn.addEventListener("click", function () {
      Store.restoreLastDeleted().then(function () {
        hideUndoBanner();
        refresh();
      }).catch(function (err) {
        alert("Could not restore: " + err);
      });
    });

    undoBanner.appendChild(label);
    undoBanner.appendChild(btn);

    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndoBanner, 10000);
  }

  function hideUndoBanner() {
    if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
    if (undoBanner && undoBanner.parentNode) {
      undoBanner.parentNode.removeChild(undoBanner);
    }
    undoBanner = null;
  }

  function render(list) {
    const ul = document.getElementById("canvas-list");
    const empty = document.getElementById("empty-message");
    ul.innerHTML = "";
    if (list.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    list.forEach(function (canvas) {
      const li = document.createElement("li");
      li.style.cursor = "pointer";
      li.addEventListener("click", function () {
        window.location.href = "canvas.html?id=" + encodeURIComponent(canvas.id);
      });

      const info = document.createElement("div");
      info.className = "canvas-info";
      const title = document.createElement("span");
      title.className = "canvas-title";
      title.textContent = canvas.title || "Untitled";
      const date = document.createElement("span");
      date.className = "canvas-date";
      date.textContent = formatDate(canvas.modifiedAt);
      info.appendChild(title);
      info.appendChild(date);

      const del = document.createElement("button");
      del.className = "canvas-delete";
      del.type = "button";
      del.textContent = "Delete";
      del.addEventListener("click", function (e) {
        e.stopPropagation();
        if (del.disabled) return;
        if (!confirm("Delete \"" + (canvas.title || "Untitled") + "\"?")) return;
        del.disabled = true;
        del.textContent = "Deleting…";
        const targetId = canvas.id;
        Store.remove(targetId).then(function () {
          const stillThere = Store.peekLastDeleted();
          if (stillThere && stillThere.id === targetId) {
            showUndoBanner(stillThere);
          }
          refresh();
        }).catch(function (err) {
          alert("Could not delete: " + err);
          del.disabled = false;
          del.textContent = "Delete";
        });
      });

      li.appendChild(info);
      li.appendChild(del);
      ul.appendChild(li);
    });
  }

  function refresh() {
    Store.list().then(render).catch(function (err) {
      alert("Could not load canvases: " + err);
    });
  }

  function openNewDialog() {
    document.getElementById("new-canvas-title").value = "";
    document.getElementById("new-canvas-dialog").hidden = false;
    document.getElementById("new-canvas-title").focus();
  }

  function closeNewDialog() {
    document.getElementById("new-canvas-dialog").hidden = true;
  }

  function confirmNew() {
    const input = document.getElementById("new-canvas-title");
    const raw = input.value.trim();
    const title = raw.length > 0 ? raw : "Untitled";
    const now = Date.now();
    const canvas = {
      id: Store.uuid(),
      schemaVersion: 1,
      title: title,
      createdAt: now,
      modifiedAt: now,
      strokes: [],
      nodes: []
    };
    Store.save(canvas).then(function () {
      closeNewDialog();
      refresh();
    }).catch(function (err) {
      alert("Could not create canvas: " + err);
    });
  }

  function wireUp() {
    document.getElementById("new-canvas-btn").addEventListener("click", openNewDialog);
    document.getElementById("cancel-new-canvas").addEventListener("click", closeNewDialog);
    document.getElementById("confirm-new-canvas").addEventListener("click", confirmNew);
    document.getElementById("new-canvas-title").addEventListener("keydown", function (e) {
      if (e.key === "Enter") confirmNew();
    });
    refresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireUp);
  } else {
    wireUp();
  }
})();
