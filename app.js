(function () {
  "use strict";

  const DB_NAME = "inkloom";
  const DB_VERSION = 1;
  const STORE = "canvases";

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function (event) {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = function (event) { resolve(event.target.result); };
      request.onerror = function (event) { reject(event.target.error); };
    });
    return dbPromise;
  }

  async function listCanvases() {
    const db = await openDB();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = function () {
        const items = req.result || [];
        items.sort(function (a, b) { return b.modifiedAt - a.modifiedAt; });
        resolve(items);
      };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function saveCanvas(canvas) {
    const db = await openDB();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(canvas);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  async function deleteCanvas(id) {
    const db = await openDB();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "id-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  }

  function formatDate(ms) {
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
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
      del.addEventListener("click", function () {
        if (confirm("Delete \"" + (canvas.title || "Untitled") + "\"?")) {
          deleteCanvas(canvas.id).then(refresh).catch(function (err) {
            alert("Could not delete: " + err);
          });
        }
      });

      li.appendChild(info);
      li.appendChild(del);
      ul.appendChild(li);
    });
  }

  async function refresh() {
    try {
      const list = await listCanvases();
      render(list);
    } catch (err) {
      alert("Could not load canvases: " + err);
    }
  }

  function openNewDialog() {
    document.getElementById("new-canvas-title").value = "";
    document.getElementById("new-canvas-dialog").hidden = false;
    document.getElementById("new-canvas-title").focus();
  }

  function closeNewDialog() {
    document.getElementById("new-canvas-dialog").hidden = true;
  }

  async function confirmNew() {
    const input = document.getElementById("new-canvas-title");
    const raw = input.value.trim();
    const title = raw.length > 0 ? raw : "Untitled";
    const now = Date.now();
    const canvas = {
      id: uuid(),
      schemaVersion: 1,
      title: title,
      createdAt: now,
      modifiedAt: now,
      strokes: [],
      nodes: []
    };
    try {
      await saveCanvas(canvas);
      closeNewDialog();
      await refresh();
    } catch (err) {
      alert("Could not create canvas: " + err);
    }
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
