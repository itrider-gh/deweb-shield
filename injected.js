(() => {
  if (window.__DEWEB_SHIELD_GUARD__) return;
  window.__DEWEB_SHIELD_GUARD__ = true;

  const sendAlert = (api, url) => {
    if (!url) return;
    try {
      window.postMessage({
        source: "DEWEB_SHIELD",
        type: "external_request",
        api,
        url: new URL(String(url), window.location.href).href,
        pageUrl: window.location.href,
        date: Date.now()
      }, window.location.origin);
    } catch (_error) {
      window.postMessage({
        source: "DEWEB_SHIELD",
        type: "external_request",
        api,
        url: String(url),
        pageUrl: window.location.href,
        date: Date.now()
      }, window.location.origin);
    }
  };

  const originalFetch = window.fetch;
  window.fetch = function shieldedFetch(input, init) {
    const url = typeof input === "string" ? input : input?.url;
    sendAlert("fetch", url);
    return originalFetch.apply(this, [input, init]);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function shieldedOpen(method, url) {
    sendAlert("xhr", url);
    return originalOpen.apply(this, arguments);
  };

  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = function ShieldedWebSocket(url, protocols) {
    sendAlert("websocket", url);
    return protocols === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocols);
  };
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  Object.defineProperty(window.WebSocket, "CONNECTING", { value: OriginalWebSocket.CONNECTING });
  Object.defineProperty(window.WebSocket, "OPEN", { value: OriginalWebSocket.OPEN });
  Object.defineProperty(window.WebSocket, "CLOSING", { value: OriginalWebSocket.CLOSING });
  Object.defineProperty(window.WebSocket, "CLOSED", { value: OriginalWebSocket.CLOSED });

  if (navigator.sendBeacon) {
    const originalSendBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function shieldedSendBeacon(url, data) {
      sendAlert("sendBeacon", url);
      return originalSendBeacon.call(navigator, url, data);
    };
  }
})();
