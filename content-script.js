const ext = globalThis.browser || globalThis.chrome;

const externalRequests = [];
const resourceSelectors = [
  ["script[src]", "src", "script"],
  ["link[href]", "href", "link"],
  ["img[src]", "src", "image"],
  ["iframe[src]", "src", "iframe"],
  ["source[src]", "src", "source"],
  ["video[src]", "src", "video"],
  ["audio[src]", "src", "audio"],
  ["form[action]", "action", "form"]
];

function safeUrl(value) {
  try {
    return new URL(value);
  } catch (_error) {
    return null;
  }
}

function absoluteUrl(value) {
  try {
    return new URL(value, window.location.href).href;
  } catch (_error) {
    return "";
  }
}

function isExternalUrl(candidate, pageUrl) {
  const url = safeUrl(candidate);
  const page = safeUrl(pageUrl);
  if (!url || !page) return false;
  if (["data:", "blob:", "about:"].includes(url.protocol)) return false;
  return url.origin !== page.origin;
}

function rememberExternal(kind, url) {
  const absolute = absoluteUrl(url);
  if (!absolute || !isExternalUrl(absolute, window.location.href)) return;
  if (externalRequests.some((entry) => entry.url === absolute && entry.kind === kind)) return;

  externalRequests.push({ kind, url: absolute, at: Date.now() });
  if (externalRequests.length > 100) externalRequests.shift();
}

function collectDomExternalResources() {
  for (const [selector, attribute, kind] of resourceSelectors) {
    document.querySelectorAll(selector).forEach((node) => {
      rememberExternal(kind, node.getAttribute(attribute));
    });
  }
}

function getCspMeta() {
  const meta = document.querySelector("meta[http-equiv='Content-Security-Policy' i]");
  return meta ? meta.getAttribute("content") || "" : "";
}

async function hashDocument() {
  const text = document.documentElement ? document.documentElement.outerHTML : document.body?.outerHTML || "";
  const encoded = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sendMessage(message) {
  const result = ext.runtime.sendMessage(message);
  if (result && typeof result.catch === "function") {
    result.catch(() => {});
  }
}

async function sendReport() {
  collectDomExternalResources();
  sendMessage({
    type: "PAGE_REPORT",
    report: {
      url: window.location.href,
      title: document.title,
      cspMeta: getCspMeta(),
      documentHash: await hashDocument(),
      externalRequests: externalRequests.slice(-100)
    }
  });
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== "DEWEB_SHIELD") return;

  rememberExternal(event.data.api, event.data.url);
  sendReport();
});

if (document.documentElement) {
  const observer = new MutationObserver(() => {
    collectDomExternalResources();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "href", "action"]
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", sendReport, { once: true });
} else {
  sendReport();
}

window.addEventListener("load", sendReport, { once: true });
setInterval(sendReport, 5000);
