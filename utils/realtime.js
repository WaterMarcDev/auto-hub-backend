// Access to the Socket.IO server from services (no req available there).
// server.js registers it once; emitting is a no-op until then (and in tests).
let ioRef = null;

function setIO(io) {
  ioRef = io;
}

/** Tell open CRM pages to refresh: emits the existing "cache:invalidate" event per scope. */
function invalidate(...scopes) {
  if (!ioRef) return;
  for (const scope of scopes) {
    try {
      ioRef.emit("cache:invalidate", { scope });
    } catch (_) {
      /* best-effort */
    }
  }
}

module.exports = { setIO, invalidate };
