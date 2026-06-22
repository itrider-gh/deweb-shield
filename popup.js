const ext = globalThis.browser || globalThis.chrome;
const usesPromiseApi = typeof globalThis.browser !== "undefined";

const nodes = {
  site: document.querySelector("#site"),
  badge: document.querySelector("#badge"),
  provider: document.querySelector("#provider"),
  providerTrust: document.querySelector("#provider-trust"),
  siteTrust: document.querySelector("#site-trust"),
  trustedNode: document.querySelector("#trusted-node"),
  integrity: document.querySelector("#integrity"),
  external: document.querySelector("#external"),
  csp: document.querySelector("#csp"),
  detail: document.querySelector("#detail"),
  reason: document.querySelector("#reason"),
  injection: document.querySelector("#injection"),
  files: document.querySelector("#files"),
  trustBanner: document.querySelector("#trust-banner"),
  progress: document.querySelector("#progress"),
  progressBar: document.querySelector("#progress-bar"),
  progressLabel: document.querySelector("#progress-label"),
  diff: document.querySelector("#diff"),
  diffOffset: document.querySelector("#diff-offset"),
  diffProvider: document.querySelector("#diff-provider"),
  diffOnChain: document.querySelector("#diff-onchain"),
  diffProviderSnippet: document.querySelector("#diff-provider-snippet"),
  diffOnChainSnippet: document.querySelector("#diff-onchain-snippet"),
  calls: document.querySelector("#calls"),
  recheck: document.querySelector("#recheck"),
  whitelist: document.querySelector("#whitelist"),
  options: document.querySelector("#options")
};

let currentState = null;
let refreshTimer = null;

function send(message) {
  if (usesPromiseApi) {
    return ext.runtime.sendMessage(message);
  }

  return new Promise((resolve, reject) => {
    try {
      const result = ext.runtime.sendMessage(message, (response) => {
        const error = ext.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
      if (result && typeof result.then === "function") {
        result.then(resolve, reject);
      }
    } catch (error) {
      reject(error);
    }
  });
}

function labelIntegrity(value) {
  return {
    verified: "Verified",
    modified: "Modified",
    checking: "Checking",
    unknown: "Unknown"
  }[value] || "Unknown";
}

function trustedNodeLabel(settings) {
  try {
    return new URL(settings.trustedNodeUrl).host;
  } catch (_error) {
    return "invalid URL";
  }
}

function render(state, settings) {
  currentState = state;
  nodes.site.textContent = `Site: ${state.siteKey || "unknown"}`;
  nodes.provider.textContent = state.providerHost || "unknown";
  nodes.providerTrust.textContent = state.providerTrusted ? "Registry trusted" : "Unknown";
  nodes.siteTrust.textContent = state.whitelisted ? "Whitelisted" : "Not trusted";
  nodes.trustedNode.textContent = trustedNodeLabel(settings);
  nodes.integrity.textContent = labelIntegrity(state.integrity);
  nodes.external.textContent = `${state.externalDetectedCount || state.externalDetected?.length || 0} in code`;
  nodes.csp.textContent = state.csp?.selfContained ? "Self-contained" : state.csp?.present ? "Warnings" : "Missing";
  nodes.detail.textContent = state.integrityDetail || "No details yet.";
  nodes.reason.textContent = state.reason ? `Detection: ${state.reason}` : "";
  if (state.injectionReport?.detected) {
    nodes.injection.textContent = state.injectionReport.valid
      ? `Server injection normalized: ${state.injectionReport.removed.join(", ")}`
      : `Server injection invalid: ${state.injectionReport.errors.join(" ")}`;
  } else {
    nodes.injection.textContent = "";
  }
  nodes.files.textContent = state.filesChecked
    ? `Files: ${state.filesVerified}/${state.filesChecked} verified${state.failedFile ? ` | Failed: ${state.failedFile}` : ""}`
    : "";
  if (state.isDeWeb) {
    nodes.trustBanner.style.display = "block";
    nodes.trustBanner.className = `trust-banner${state.whitelisted ? " trusted" : ""}`;
    nodes.trustBanner.textContent = state.whitelisted
      ? "This site is whitelisted. External links are allowed and the page reloads when trust changes."
      : "External links are disabled by default for this DeWeb site. Whitelist the site to allow them, then the page will reload.";
  } else {
    nodes.trustBanner.style.display = "none";
    nodes.trustBanner.textContent = "";
  }
  const progress = state.integrityProgress;
  if (progress && (state.integrity === "checking" || progress.cached)) {
    const percent = Number.isFinite(progress.percent)
      ? progress.percent
      : Math.round((Number(progress.current || 0) / Math.max(1, Number(progress.total || 1))) * 100);
    nodes.progress.style.display = "block";
    nodes.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    nodes.progressLabel.textContent = progress.cached
      ? "Integrity result served from cache"
      : `${progress.phase || "Checking"}${progress.filePath ? `: ${progress.filePath}` : ""} (${progress.current || 0}/${progress.total || 1})`;
  } else {
    nodes.progress.style.display = "none";
    nodes.progressBar.style.width = "0%";
    nodes.progressLabel.textContent = "";
  }
  nodes.whitelist.textContent = state.whitelisted ? "Remove site trust" : "Trust this site";
  nodes.whitelist.disabled = !state.siteKey;
  nodes.recheck.disabled = !state.isDeWeb;

  nodes.badge.className = `badge ${state.integrity || "neutral"}`;
  nodes.badge.textContent = state.isDeWeb
    ? state.integrity === "unknown" ? "DeWeb" : labelIntegrity(state.integrity)
    : "Not DeWeb";

  const diff = state.integrityDiff;
  nodes.diff.style.display = diff ? "block" : "none";
  if (diff) {
    nodes.diffOffset.textContent = String(diff.firstDiffOffset);
    nodes.diffProvider.textContent = `${diff.providerHashShort}... (${diff.providerSize} bytes)`;
    nodes.diffOnChain.textContent = `${diff.onChainHashShort}... (${diff.onChainSize} bytes)`;
    nodes.diffProviderSnippet.textContent = diff.providerSnippet ? `Provider: ${diff.providerSnippet}` : "Provider snippet unavailable for binary content.";
    nodes.diffOnChainSnippet.textContent = diff.onChainSnippet ? `On-chain: ${diff.onChainSnippet}` : "On-chain snippet unavailable for binary content.";
  }

  nodes.calls.replaceChildren();
  const calls = state.externalDetected || [];
  if (calls.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No external links found in page code.";
    nodes.calls.append(empty);
    return;
  }

  calls.slice().reverse().forEach((call) => {
    const li = document.createElement("li");
    const type = document.createElement("span");
    const url = document.createElement("strong");
    type.textContent = call.kind || call.type || "url";
    url.textContent = call.url;
    li.append(type, url);
    nodes.calls.append(li);
  });
}

async function refresh() {
  const response = await send({ type: "GET_POPUP_STATE" });
  if (response?.ok) {
    render(response.state, response.settings);
    if (response.state?.integrity === "checking") {
      scheduleProgressRefresh();
    }
  } else {
    nodes.detail.textContent = response?.error || "Background did not answer. Reload the extension from manifest.json.";
  }
}

function scheduleProgressRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(async () => {
    if (currentState?.integrity === "checking") {
      await refresh();
      return;
    }
    clearInterval(refreshTimer);
    refreshTimer = null;
  }, 1000);
}

nodes.whitelist.addEventListener("click", async () => {
  if (!currentState?.siteKey) return;
  nodes.whitelist.disabled = true;
  const response = await send({ type: "TOGGLE_SITE_WHITELIST", siteKey: currentState.siteKey });
  if (response?.ok && response.state) {
    render(response.state, response.settings);
    return;
  }
  await refresh();
});

nodes.recheck.addEventListener("click", async () => {
  nodes.recheck.disabled = true;
  nodes.detail.textContent = "Rechecking trusted node...";
  const response = await send({ type: "RECHECK_INTEGRITY" });
  if (response?.ok) {
    render(response.state, response.settings);
    scheduleProgressRefresh();
  } else {
    const error = response?.error || "Could not recheck integrity.";
    nodes.detail.textContent = error.includes("Unknown message type")
      ? "Background is stale. Reload the extension, then reopen this popup."
      : error;
  }
});

nodes.options.addEventListener("click", () => {
  if (ext.runtime.openOptionsPage) {
    if (usesPromiseApi) {
      ext.runtime.openOptionsPage()
        .catch(() => ext.tabs.create({ url: ext.runtime.getURL("options.html") }));
      return;
    }

    ext.runtime.openOptionsPage(() => {
      if (!ext.runtime.lastError) return;
      ext.tabs.create({ url: ext.runtime.getURL("options.html") });
    });
    return;
  }

  ext.tabs.create({ url: ext.runtime.getURL("options.html") });
});

refresh().catch((error) => {
  nodes.detail.textContent = error.message;
});
