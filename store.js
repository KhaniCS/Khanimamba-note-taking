(function () {
  "use strict";

  const DB_NAME = "inkloom";
  const DB_VERSION = 1;
  const STORE = "canvases";

  let dbPromise = null;
  let queue = Promise.resolve();
  let lastDeleted = null;
  let undoTimer = null;
  let undoListeners = [];

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

  function enqueue(job) {
    const next = queue.then(function () { return job(); });
    queue = next.catch(function () { /* swallow so queue keeps moving */ });
    return next;
  }

  function run(store_mode, action) {
    return enqueue(async function () {
      const db = await openDB();
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE, store_mode);
        let result;
        const store = tx.objectStore(STORE);
        try {
          result = action(store);
        } catch (err) {
          reject(err);
          return;
        }
        tx.oncomplete = function () { resolve(result && result.value); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error("transaction aborted")); };
      });
    });
  }

  function notifyUndo() {
    const snapshot = lastDeleted;
    undoListeners.forEach(function (fn) {
      try { fn(snapshot); } catch (err) { /* ignore listener errors */ }
    });
  }

  function setLastDeleted(value, seconds) {
    lastDeleted = value;
    if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
    if (value) {
      undoTimer = setTimeout(function () {
        lastDeleted = null;
        undoTimer = null;
        notifyUndo();
      }, seconds * 1000);
    }
    notifyUndo();
  }

  const Store = {
    list: function () {
      return run("readonly", function (store) {
        const req = store.getAll();
        const out = { value: [] };
        req.onsuccess = function () {
          const items = req.result || [];
          items.sort(function (a, b) { return b.modifiedAt - a.modifiedAt; });
          out.value = items;
        };
        return out;
      });
    },

    get: function (id) {
      return run("readonly", function (store) {
        const req = store.get(id);
        const out = { value: null };
        req.onsuccess = function () { out.value = req.result || null; };
        return out;
      });
    },

    save: function (canvas) {
      return run("readwrite", function (store) {
        store.put(canvas);
        return { value: true };
      });
    },

    remove: function (id) {
      return enqueue(async function () {
        const db = await openDB();
        return new Promise(function (resolve, reject) {
          const tx = db.transaction(STORE, "readwrite");
          const store = tx.objectStore(STORE);
          const getReq = store.get(id);
          let found = null;
          getReq.onsuccess = function () {
            found = getReq.result || null;
            if (found) {
              store.delete(id);
            }
          };
          tx.oncomplete = function () {
            if (found) {
              setLastDeleted(found, 10);
            }
            resolve(true);
          };
          tx.onerror = function () { reject(tx.error); };
          tx.onabort = function () { reject(tx.error || new Error("transaction aborted")); };
        });
      });
    },

    restoreLastDeleted: function () {
      if (!lastDeleted) return Promise.resolve(false);
      const snapshot = lastDeleted;
      setLastDeleted(null, 0);
      return Store.save(snapshot).then(function () { return true; });
    },

    peekLastDeleted: function () {
      return lastDeleted;
    },

    onUndoChange: function (fn) {
      undoListeners.push(fn);
      try { fn(lastDeleted); } catch (err) { /* ignore */ }
      return function () {
        undoListeners = undoListeners.filter(function (other) { return other !== fn; });
      };
    },

    uuid: function () {
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID();
      }
      return "id-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    }
  };

  window.Store = Store;
})();
