const ext = globalThis.browser || globalThis.chrome;

const externalLinks = [];
const resourceSelectors = [
  ["script[src]", "src", "script"],
  ["link[href]", "href", "link"],
  ["a[href]", "href", "anchor"],
  ["area[href]", "href", "area"],
  ["img[src]", "src", "image"],
  ["iframe[src]", "src", "iframe"],
  ["embed[src]", "src", "embed"],
  ["object[data]", "data", "object"],
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
  if (externalLinks.some((entry) => entry.url === absolute)) return;

  externalLinks.push({ kind, url: absolute, source: "code", at: Date.now() });
  if (externalLinks.length > 200) externalLinks.shift();
}

function collectDomExternalResources() {
  for (const [selector, attribute, kind] of resourceSelectors) {
    document.querySelectorAll(selector).forEach((node) => {
      rememberExternal(kind, node.getAttribute(attribute));
    });
  }
}

function collectInlineExternalLinks() {
  const html = document.documentElement?.outerHTML || "";
  const matches = html.matchAll(/https?:\/\/[^\s"'<>`\\)]+|\/\/[^\s"'<>`\\)]+/gi);
  for (const match of matches) {
    rememberExternal("url", match[0]);
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
  collectInlineExternalLinks();
  sendMessage({
    type: "PAGE_REPORT",
    report: {
      url: window.location.href,
      title: document.title,
      cspMeta: getCspMeta(),
      documentHash: await hashDocument(),
      externalLinks: externalLinks.slice(-200)
    }
  });
}

if (document.documentElement) {
  const observer = new MutationObserver(() => {
    collectDomExternalResources();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "href", "action", "data"]
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", sendReport, { once: true });
} else {
  sendReport();
}

window.addEventListener("load", sendReport, { once: true });
setInterval(sendReport, 5000);
