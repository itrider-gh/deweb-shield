const ext = globalThis.browser || globalThis.chrome;
const usesPromiseApi = typeof globalThis.browser !== "undefined";
const form = document.querySelector("#settings-form");
const saved = document.querySelector("#saved");

const controls = {
  trustedNodeUrl: document.querySelector("#trusted-node-url"),
  providerRegistryUrl: document.querySelector("#provider-registry-url"),
  trustLocalProvider: document.querySelector("#trust-local-provider"),
  askBeforeUnknownProvider: document.querySelector("#ask-before-unknown"),
  blockExternalCalls: document.querySelector("#block-external"),
  enforceCsp: document.querySelector("#enforce-csp"),
  autoSyncProviders: document.querySelector("#auto-sync-providers"),
  trustedProviders: document.querySelector("#trusted-providers"),
  whitelist: document.querySelector("#whitelist"),
  providerRegistryStatus: document.querySelector("#provider-registry-status"),
  syncProviders: document.querySelector("#sync-providers")
};

function linesToMap(value, entryFactory) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce((map, line) => {
      map[line] = entryFactory();
      return map;
    }, {});
}

function mapToLines(map, predicate) {
  return Object.entries(map || {})
    .filter(([, value]) => predicate(value))
    .map(([key]) => key)
    .sort()
    .join("\n");
}

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

function renderProviderRegistry(registry = {}) {
  const count = Object.keys(registry.providers || {}).length;
  const fetchedAt = registry.fetchedAt ? new Date(registry.fetchedAt).toLocaleString() : "never";
  const suffix = registry.error ? `, last error: ${registry.error}` : "";
  controls.providerRegistryStatus.textContent = `${count} providers loaded, last sync: ${fetchedAt}${suffix}`;
}

async function load() {
  const response = await send({ type: "GET_SETTINGS" });
  if (!response?.ok) {
    throw new Error(response?.error || "Background did not answer. Reload the extension from manifest.json.");
  }
  const settings = response.settings;
  controls.trustedNodeUrl.value = settings.trustedNodeUrl;
  controls.providerRegistryUrl.value = settings.providerRegistryUrl;
  controls.trustLocalProvider.checked = settings.trustLocalProvider;
  controls.askBeforeUnknownProvider.checked = settings.askBeforeUnknownProvider;
  controls.blockExternalCalls.checked = settings.blockExternalCalls;
  controls.enforceCsp.checked = settings.enforceCsp;
  controls.autoSyncProviders.checked = settings.autoSyncProviders;
  controls.trustedProviders.value = mapToLines(settings.trustedProviders, Boolean);
  controls.whitelist.value = mapToLines(settings.whitelist, (value) => value?.trustExternalCalls);
  renderProviderRegistry(response.providerRegistry);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  saved.textContent = "Saving...";

  const settings = {
    trustedNodeUrl: controls.trustedNodeUrl.value.trim(),
    providerRegistryUrl: controls.providerRegistryUrl.value.trim(),
    trustLocalProvider: controls.trustLocalProvider.checked,
    askBeforeUnknownProvider: controls.askBeforeUnknownProvider.checked,
    blockExternalCalls: controls.blockExternalCalls.checked,
    enforceCsp: controls.enforceCsp.checked,
    autoSyncProviders: controls.autoSyncProviders.checked,
    trustedProviders: linesToMap(controls.trustedProviders.value, () => true),
    whitelist: linesToMap(controls.whitelist.value, () => ({ trustExternalCalls: true }))
  };

  const response = await send({ type: "SAVE_SETTINGS", settings });
  saved.textContent = response?.ok ? "Saved" : response?.error || "Could not save";
  setTimeout(() => {
    saved.textContent = "";
  }, 1800);
});

controls.syncProviders.addEventListener("click", async () => {
  controls.syncProviders.disabled = true;
  saved.textContent = "Syncing providers...";
  try {
    const response = await send({ type: "SYNC_PROVIDERS" });
    if (!response?.ok) throw new Error(response?.error || "Could not sync providers.");
    renderProviderRegistry(response.providerRegistry);
    saved.textContent = "Providers synced";
  } catch (error) {
    saved.textContent = error.message;
  } finally {
    controls.syncProviders.disabled = false;
  }
});

load().catch((error) => {
  saved.textContent = error.message;
});
