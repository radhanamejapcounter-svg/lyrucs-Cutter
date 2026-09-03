/* coi-serviceworker v0.1.7 - enabling SharedArrayBuffer on GitHub Pages */
(() => {
  if (typeof window === "undefined") {
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
    self.addEventListener("fetch", (e) => {
      if (e.request.cache === "only-if-cached" && e.request.mode !== "same-origin") return;
      e.respondWith(
        fetch(e.request).then((r) => {
          if (r.status === 0) return r;
          const headers = new Headers(r.headers);
          headers.set("Cross-Origin-Opener-Policy", "same-origin");
          headers.set("Cross-Origin-Embedder-Policy", "require-corp");
          return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
        })
      );
    });
    return;
  }

  if (!crossOriginIsolated) {
    const registration = navigator.serviceWorker
      .register(window.document.currentScript.src)
      .then(() => navigator.serviceWorker.ready)
      .then(() => {
        if (!crossOriginIsolated) window.location.reload();
      });
    const script = window.document.currentScript;
    if (script.dataset.reloadedAt) return;
    if (!navigator.serviceWorker.controller) {
      window.addEventListener("load", () => {
        window.location.reload();
      }, { once: true });
    }
  }
})();
