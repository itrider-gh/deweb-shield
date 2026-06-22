const ext = globalThis.browser || globalThis.chrome;
const usesPromiseApi = typeof globalThis.browser !== "undefined";
const INTEGRITY_CACHE_VERSION = "integrity-v4";

if (typeof verifyDeWebIntegrity === "undefined" && typeof importScripts === "function") {
  importScripts("deweb-integrity.js");
}

const DEFAULT_SETTINGS = {
  trustedNodeUrl: "https://mainnet.massa.net/api/v2",
  providerRegistryUrl: "https://raw.githubusercontent.com/massalabs/DeWeb-Providers/main/providers.yaml",
  trustLocalProvider: false,
  askBeforeUnknownProvider: true,
  blockExternalCalls: true,
  enforceCsp: true,
  autoSyncProviders: true,
  providerSyncIntervalHours: 12,
  integrityCacheTtlMinutes: 10,
  whitelist: {},
  trustedProviders: {
    "deweb.massa.net": true,
    "massahub.network": true
  }
};

const LEGACY_DEFAULT_TRUSTED_NODE_URL = "http://127.0.0.1:33035";

const EXTERNAL_RESOURCE_TYPES = [
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other"
];

const DEWEB_HOST_SUFFIXES = [
  ".massa",
  ".massahub.network"
];

const DEWEB_EXACT_HOSTS = [
  "massa",
  "deweb.massa.net",
  "massahub.network"
];

const stateByTab = new Map();
const externalLogByTab = new Map();
const cspHeaderByTab = new Map();
const pageReportByTab = new Map();
const integrityCacheByKey = new Map();
let providerRegistryCache = {
  providers: {},
  fetchedAt: null,
  error: ""
};

function safeUrl(value) {
  try {
    return new URL(value);
  } catch (_error) {
    return null;
  }
}

function hostWithoutPort(host) {
  const clean = String(host || "").replace(/^\[|\]$/g, "").toLowerCase();
  if ((clean.match(/:/g) || []).length > 1) {
    return clean;
  }
  return clean.replace(/:\d+$/, "");
}

function isPrivateHost(host) {
  const clean = hostWithoutPort(host);
  return clean === "localhost" ||
    clean === "127.0.0.1" ||
    clean === "::1" ||
    clean.startsWith("192.168.") ||
    clean.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(clean);
}

function isExternalUrl(candidate, pageUrl) {
  const url = safeUrl(candidate);
  const page = safeUrl(pageUrl);
  if (!url || !page) return false;
  if (["data:", "blob:", "about:"].includes(url.protocol)) return false;
  return url.origin !== page.origin;
}

function normalizeTrustLocalProvider(settings = {}) {
  if (typeof settings.trustLocalProvider === "boolean") {
    return settings.trustLocalProvider;
  }
  return settings.mode === "local" || settings.mode === "local-provider";
}

function normalizeSettings(settings = {}) {
  const { mode: _legacyMode, ...rest } = settings;
  const trustLocalProvider = normalizeTrustLocalProvider(settings);
  const trustedNodeUrl = !settings.trustedNodeUrl || settings.trustedNodeUrl === LEGACY_DEFAULT_TRUSTED_NODE_URL
    ? DEFAULT_SETTINGS.trustedNodeUrl
    : settings.trustedNodeUrl;
  const trustedProviders = {
    ...DEFAULT_SETTINGS.trustedProviders,
    ...(settings.trustedProviders || {})
  };

  return {
    ...DEFAULT_SETTINGS,
    ...rest,
    trustedNodeUrl,
    trustLocalProvider,
    whitelist: {
      ...DEFAULT_SETTINGS.whitelist,
      ...(settings.whitelist || {})
    },
    trustedProviders
  };
}

function addLocalProviders(trustedProviders = {}) {
  return {
    ...trustedProviders,
    localhost: true,
    "127.0.0.1": true,
    "::1": true
  };
}

function normalizeProviderHost(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const asUrl = safeUrl(raw.includes("://") ? raw : `https://${raw}`);
  if (!asUrl || !asUrl.hostname) return "";
  return hostWithoutPort(asUrl.hostname);
}

function findProviderMatch(host, providers = {}) {
  const clean = hostWithoutPort(host);
  let bestMatch = "";

  for (const providerHost of Object.keys(providers)) {
    const provider = hostWithoutPort(providerHost);
    const matches = clean === provider || clean.endsWith(`.${provider}`);
    if (matches && provider.length > bestMatch.length) {
      bestMatch = provider;
    }
  }

  return bestMatch;
}

function parseProviderYaml(yamlText) {
  const providers = {};
  const candidates = new Set();
  const urlPattern = /https?:\/\/[^\s"'<>]+/g;
  const hostPattern = /(?:host|hostname|domain|provider|url)\s*:\s*["']?([^"'\s#]+)["']?/gi;
  const listHostPattern = /^\s*-\s*["']?([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?\/?["']?\s*(?:#.*)?$/gim;

  for (const match of yamlText.matchAll(urlPattern)) {
    candidates.add(match[0]);
  }

  for (const match of yamlText.matchAll(hostPattern)) {
    candidates.add(match[1]);
  }

  for (const match of yamlText.matchAll(listHostPattern)) {
    candidates.add(match[1]);
  }

  for (const candidate of candidates) {
    const host = normalizeProviderHost(candidate.replace(/[),\]]+$/, ""));
    if (host) providers[host] = true;
  }

  return providers;
}

async function refreshProviderRegistry(force = false) {
  const settings = await getSettings();
  if (!settings.autoSyncProviders && !force) {
    return providerRegistryCache;
  }

  const lastFetchAge = providerRegistryCache.fetchedAt ? Date.now() - providerRegistryCache.fetchedAt : Infinity;
  const minAge = Math.max(1, settings.providerSyncIntervalHours) * 60 * 60 * 1000;
  if (!force && providerRegistryCache.fetchedAt && lastFetchAge < minAge) {
    return providerRegistryCache;
  }

  try {
    const response = await fetch(settings.providerRegistryUrl, {
      cache: "no-store",
      headers: { accept: "text/yaml,text/plain,*/*" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const yamlText = await response.text();
    const providers = parseProviderYaml(yamlText);
    providerRegistryCache = {
      providers,
      fetchedAt: Date.now(),
      error: ""
    };
    await storageSet("local", { providerRegistryCache });
    return providerRegistryCache;
  } catch (error) {
    providerRegistryCache = {
      ...providerRegistryCache,
      error: error.message
    };
    await storageSet("local", { providerRegistryCache });
    return providerRegistryCache;
  }
}

async function loadProviderRegistryCache() {
  const stored = await storageGet("local", { providerRegistryCache });
  providerRegistryCache = {
    ...providerRegistryCache,
    ...(stored.providerRegistryCache || {})
  };
}

async function getMergedTrustedProviders() {
  const settings = await getSettings();
  const registry = settings.autoSyncProviders ? await refreshProviderRegistry(false) : providerRegistryCache;
  let trustedProviders = {
    ...settings.trustedProviders,
    ...(registry.providers || {})
  };
  if (settings.trustLocalProvider) {
    trustedProviders = addLocalProviders(trustedProviders);
  }
  return trustedProviders;
}

function isKnownDeWebHost(host) {
  return DEWEB_EXACT_HOSTS.includes(host) ||
    DEWEB_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function detectDeWeb(urlValue, trustedProviders = {}) {
  const url = safeUrl(urlValue);
  if (!url) {
    return { isDeWeb: false, reason: "invalid-url", siteKey: "", providerHost: "" };
  }

  const host = hostWithoutPort(url.hostname);
  const path = url.pathname.toLowerCase();
  const params = url.searchParams;
  const matchedProvider = findProviderMatch(host, trustedProviders);
  const fromTrustedProvider = Boolean(matchedProvider);
  const fromKnownHost = isKnownDeWebHost(host);
  const isDeWeb = fromTrustedProvider ||
    fromKnownHost ||
    (host.includes("deweb") && path.includes("massa")) ||
    params.has("massa") ||
    params.has("deweb") ||
    params.has("address");

  return {
    isDeWeb,
    reason: fromTrustedProvider ? "provider-registry" : isDeWeb ? "deweb-hint" : "regular-web",
    siteKey: host,
    providerHost: matchedProvider || host,
    pageHost: host
  };
}

function summarizeCsp(cspValue) {
  if (!cspValue) {
    return { present: false, selfContained: false, warnings: ["missing-csp"] };
  }

  const lowered = cspValue.toLowerCase();
  const warnings = [];
  if (!lowered.includes("default-src")) warnings.push("missing-default-src");
  if (lowered.includes("unsafe-inline")) warnings.push("unsafe-inline");
  if (lowered.includes("unsafe-eval")) warnings.push("unsafe-eval");
  if (/\bhttps?:/.test(lowered)) warnings.push("external-sources");

  return {
    present: true,
    selfContained: warnings.length === 0 && lowered.includes("'self'"),
    warnings
  };
}

function hashRuleId(host) {
  let hash = 2166136261;
  for (let i = 0; i < host.length; i += 1) {
    hash ^= host.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 1000 + (Math.abs(hash) % 1000000);
}

function storageGet(area, defaults) {
  if (usesPromiseApi) {
    return ext.storage[area].get(defaults);
  }

  return new Promise((resolve, reject) => {
    try {
      const result = ext.storage[area].get(defaults, (value) => {
        const error = ext.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(value);
      });
      if (result && typeof result.then === "function") {
        result.then(resolve, reject);
      }
    } catch (error) {
      reject(error);
    }
  });
}

function storageSet(area, value) {
  if (usesPromiseApi) {
    return ext.storage[area].set(value);
  }

  return new Promise((resolve, reject) => {
    try {
      const result = ext.storage[area].set(value, () => {
        const error = ext.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
      if (result && typeof result.then === "function") {
        result.then(resolve, reject);
      }
    } catch (error) {
      reject(error);
    }
  });
}

function tabsQuery(queryInfo) {
  if (usesPromiseApi) {
    return ext.tabs.query(queryInfo);
  }

  return new Promise((resolve, reject) => {
    try {
      ext.tabs.query(queryInfo, (tabs) => {
        const error = ext.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(tabs || []);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function reloadTab(tabId) {
  if (usesPromiseApi) {
    return ext.tabs.reload(tabId);
  }

  return new Promise((resolve, reject) => {
    ext.tabs.reload(tabId, () => {
      const error = ext.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function updateSessionRules(options) {
  if (!ext.declarativeNetRequest) {
    return Promise.resolve();
  }

  if (usesPromiseApi) {
    return ext.declarativeNetRequest.updateSessionRules(options);
  }

  return new Promise((resolve, reject) => {
    try {
      ext.declarativeNetRequest.updateSessionRules(options, () => {
        const error = ext.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function getSettings() {
  const stored = await storageGet("sync", DEFAULT_SETTINGS);
  const normalized = normalizeSettings(stored);
  if (
    stored.trustedNodeUrl === LEGACY_DEFAULT_TRUSTED_NODE_URL ||
    stored.mode === "local" ||
    stored.mode === "remote" ||
    stored.mode === "local-provider" ||
    stored.mode === "trusted-node" ||
    typeof stored.trustLocalProvider !== "boolean"
  ) {
    await storageSet("sync", normalized);
  }
  return normalized;
}

async function saveSettings(settings) {
  await storageSet("sync", normalizeSettings(settings));
}

function getTabState(tabId) {
  return stateByTab.get(tabId) || {
    tabId,
    url: "",
    siteKey: "",
    providerHost: "",
    isDeWeb: false,
    integrity: "unknown",
    integrityDetail: "No DeWeb page detected yet.",
    externalBlocked: 0,
    externalDetectedCount: 0,
    externalDetected: [],
    integrityProgress: null,
    csp: { present: false, selfContained: false, warnings: [] },
    whitelisted: false,
    lastCheckedAt: null
  };
}

function setTabState(tabId, patch) {
  const next = { ...getTabState(tabId), ...patch };
  stateByTab.set(tabId, next);
  return next;
}

function integrityCacheKey(settings, tabState, pageReport) {
  const url = safeUrl(pageReport.url || tabState.url);
  return [
    INTEGRITY_CACHE_VERSION,
    settings.trustedNodeUrl,
    url?.origin || "",
    tabState.pageHost || tabState.siteKey || "",
    tabState.providerHost || ""
  ].join("|");
}

function getCachedIntegrity(cacheKey, ttlMinutes) {
  const cached = integrityCacheByKey.get(cacheKey);
  if (!cached) return null;

  const ttlMs = Math.max(1, ttlMinutes || DEFAULT_SETTINGS.integrityCacheTtlMinutes) * 60 * 1000;
  if (Date.now() - cached.cachedAt > ttlMs) {
    integrityCacheByKey.delete(cacheKey);
    return null;
  }

  return cached.result;
}

async function saveIntegrityCache() {
  const entries = Array.from(integrityCacheByKey.entries())
    .slice(-50)
    .map(([key, value]) => ({ key, ...value }));
  await storageSet("local", { integrityCacheEntries: entries });
}

async function loadIntegrityCache() {
  const stored = await storageGet("local", { integrityCacheEntries: [] });
  for (const entry of stored.integrityCacheEntries || []) {
    if (entry.key && entry.result && entry.cachedAt) {
      integrityCacheByKey.set(entry.key, {
        cachedAt: entry.cachedAt,
        result: entry.result
      });
    }
  }
}

async function setCachedIntegrity(cacheKey, result) {
  integrityCacheByKey.set(cacheKey, {
    cachedAt: Date.now(),
    result
  });
  await saveIntegrityCache();
}

function integrityResultPatch(result, fromCache = false) {
  return {
    integrity: result.verified ? "verified" : "modified",
    integrityDetail: result.verified
      ? `Verified ${result.filesVerified}/${result.filesChecked} files via MNS ${result.mnsName} -> ${result.websiteAddress}${result.injection?.applied ? " (DeWeb label normalized)" : ""}${fromCache ? " (cached)" : ""}`
      : result.injection?.valid === false
        ? `Modified: DeWeb server injection is not template-compliant (${result.injection.errors.join(" ")})${fromCache ? " (cached)" : ""}`
        : `Modified: ${result.failedFile || result.onChainPath} differs from on-chain (${result.filesVerified}/${result.filesChecked} files verified)${fromCache ? " (cached)" : ""}`,
    mnsName: result.mnsName,
    websiteAddress: result.websiteAddress,
    requestedPath: result.requestedPath,
    onChainPath: result.onChainPath,
    trustedNodeHash: result.onChainHash,
    pageHash: result.providerHash,
    integrityDiff: result.diff,
    injectionReport: result.injection,
    filesChecked: result.filesChecked,
    filesVerified: result.filesVerified,
    failedFile: result.failedFile,
    fileResults: result.fileResults,
    integrityProgress: {
      phase: fromCache ? "Cached" : "Complete",
      current: result.filesChecked || 1,
      total: result.filesChecked || 1,
      percent: 100,
      cached: fromCache
    },
    lastCheckedAt: Date.now()
  };
}

async function upsertExternalBlockingRule(urlValue, enabled) {
  if (!ext.declarativeNetRequest) return;
  const url = safeUrl(urlValue);
  if (!url || !url.hostname) return;

  const host = hostWithoutPort(url.hostname);
  const id = hashRuleId(host);
  try {
    await updateSessionRules({ removeRuleIds: [id] });
    if (!enabled) return;

    await updateSessionRules({
      addRules: [{
        id,
        priority: 1,
        action: { type: "block" },
        condition: {
          initiatorDomains: [host],
          excludedRequestDomains: [host],
          resourceTypes: EXTERNAL_RESOURCE_TYPES
        }
      }]
    });
  } catch (error) {
    console.warn("[DeWeb Shield] Could not update network blocking rules:", error);
  }
}

async function refreshTabPolicy(tabId, urlValue) {
  const settings = await getSettings();
  const trustedProviders = await getMergedTrustedProviders();
  const detection = detectDeWeb(urlValue, trustedProviders);
  const siteSettings = settings.whitelist[detection.siteKey] || {};
  const whitelisted = Boolean(siteSettings.trustExternalCalls);
  const providerTrusted = Boolean(findProviderMatch(detection.pageHost || detection.providerHost, trustedProviders));
  const shouldBlock = detection.isDeWeb && settings.blockExternalCalls && !whitelisted;

  await upsertExternalBlockingRule(urlValue, shouldBlock);
  if (!shouldBlock && externalLogByTab.has(tabId)) {
    externalLogByTab.set(tabId, externalLogByTab.get(tabId).map((entry) => ({
      ...entry,
      blocked: false
    })));
  }
  const currentExternalLog = externalLogByTab.get(tabId) || [];
  return setTabState(tabId, {
    url: urlValue,
    ...detection,
    whitelisted,
    providerTrusted,
    shouldBlock,
    externalBlocked: currentExternalLog.filter((entry) => entry.blocked).length
  });
}

async function compareWithTrustedNode(tabId, pageReport, options = {}) {
  const settings = await getSettings();
  const trustedNode = safeUrl(settings.trustedNodeUrl);
  if (!trustedNode) {
    return setTabState(tabId, {
      integrity: "unknown",
      integrityDetail: "Trusted node URL is invalid.",
      lastCheckedAt: Date.now()
    });
  }

  try {
    const tabState = getTabState(tabId);
    const cacheKey = integrityCacheKey(settings, tabState, pageReport);
    const cached = options.force ? null : getCachedIntegrity(cacheKey, settings.integrityCacheTtlMinutes);
    if (cached) {
      return setTabState(tabId, integrityResultPatch(cached, true));
    }

    setTabState(tabId, {
      integrity: "checking",
      integrityDetail: "Checking trusted node...",
      integrityProgress: {
        phase: "Starting",
        current: 0,
        total: 1,
        percent: 0,
        cached: false
      }
    });

    const result = await verifyDeWebIntegrity({
      nodeUrl: settings.trustedNodeUrl,
      pageUrl: pageReport.url,
      pageHost: tabState.pageHost || tabState.siteKey,
      providerHost: tabState.providerHost,
      onProgress: (progress) => {
        const total = Math.max(1, Number(progress.total || 1));
        const current = Math.max(0, Number(progress.current || 0));
        const percent = Math.max(0, Math.min(99, Math.round((current / total) * 100)));
        setTabState(tabId, {
          integrity: "checking",
          integrityDetail: progress.filePath
            ? `${progress.phase}: ${progress.filePath}`
            : progress.phase || "Checking trusted node...",
          integrityProgress: {
            ...progress,
            current,
            total,
            percent,
            cached: false
          }
        });
      }
    });
    await setCachedIntegrity(cacheKey, result);
    return setTabState(tabId, integrityResultPatch(result, false));
  } catch (error) {
    return setTabState(tabId, {
      integrity: "unknown",
      integrityDetail: `Trusted-node verification unavailable: ${error.message}`,
      pageHash: pageReport.documentHash,
      integrityProgress: null,
      lastCheckedAt: Date.now()
    });
  }
}

function recordExternalRequest(details) {
  const tabId = details.tabId;
  if (tabId < 0) return;

  const tabState = getTabState(tabId);
  if (!tabState.isDeWeb || !tabState.shouldBlock || !isExternalUrl(details.url, tabState.url)) return;

  const nextList = upsertExternalRequest(externalLogByTab.get(tabId) || [], {
    url: details.url,
    type: details.type,
    timeStamp: details.timeStamp,
    blocked: true,
    source: "network"
  });
  externalLogByTab.set(tabId, nextList);
  setTabState(tabId, {
    externalBlocked: nextList.filter((entry) => entry.blocked).length
  });
}

function rememberRequestedExternal(details, blocked) {
  const tabId = details.tabId;
  if (tabId < 0) return;

  const tabState = getTabState(tabId);
  if (!tabState.isDeWeb || !isExternalUrl(details.url, tabState.url)) return;

  const nextList = upsertExternalRequest(externalLogByTab.get(tabId) || [], {
    url: details.url,
    type: details.type,
    timeStamp: details.timeStamp || Date.now(),
    blocked,
    source: "network"
  });
  externalLogByTab.set(tabId, nextList);
  setTabState(tabId, {
    externalBlocked: nextList.filter((entry) => entry.blocked).length
  });
}

function externalRequestKey(entry) {
  return `${entry.type || entry.kind || "request"}:${entry.url}`;
}

function mergeExternalRequestEntry(previous, next) {
  if (!previous) {
    return {
      ...next,
      blocked: Boolean(next.blocked)
    };
  }

  return {
    ...previous,
    ...next,
    blocked: Boolean(previous.blocked || next.blocked),
    source: previous.source === "network" || next.source === "network" ? "network" : previous.source || next.source,
    timeStamp: Math.max(Number(previous.timeStamp || 0), Number(next.timeStamp || 0)) || previous.timeStamp || next.timeStamp
  };
}

function dedupeExternalRequests(requests, limit = 100) {
  const byKey = new Map();
  for (const request of requests) {
    if (!request?.url) continue;
    const key = externalRequestKey(request);
    byKey.set(key, mergeExternalRequestEntry(byKey.get(key), request));
  }
  return Array.from(byKey.values())
    .sort((a, b) => Number(a.timeStamp || 0) - Number(b.timeStamp || 0))
    .slice(-limit);
}

function upsertExternalRequest(requests, request) {
  return dedupeExternalRequests([...requests, request]);
}

function normalizeExternalLinks(links) {
  return dedupeExternalRequests((links || []).map((link) => ({
    ...link,
    blocked: false,
    source: "code",
    timeStamp: link.timeStamp || link.at || Date.now()
  })), 200);
}

function recordMainFrameHeaders(details) {
  if (details.tabId < 0) return;
  const cspHeader = (details.responseHeaders || []).find((header) => {
    return header.name && header.name.toLowerCase() === "content-security-policy";
  });

  if (cspHeader?.value) {
    cspHeaderByTab.set(details.tabId, cspHeader.value);
    setTabState(details.tabId, { csp: summarizeCsp(cspHeader.value) });
  }
}

ext.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const nextUrl = changeInfo.url || tab.url;
  if (nextUrl) refreshTabPolicy(tabId, nextUrl).catch(console.error);
});

ext.tabs.onRemoved.addListener((tabId) => {
  stateByTab.delete(tabId);
  externalLogByTab.delete(tabId);
  cspHeaderByTab.delete(tabId);
  pageReportByTab.delete(tabId);
});

function handleBeforeRequest(details) {
  if (details.tabId < 0) return {};

  if (details.type === "main_frame") {
    externalLogByTab.delete(details.tabId);
    cspHeaderByTab.delete(details.tabId);
    setTabState(details.tabId, {
      externalBlocked: 0,
      externalDetectedCount: 0,
      externalDetected: [],
      csp: { present: false, selfContained: false, warnings: [] },
      integrity: "unknown",
      integrityDetail: "Navigation started."
    });
    return {};
  }

  const tabState = getTabState(details.tabId);
  const external = tabState.isDeWeb && isExternalUrl(details.url, tabState.url);
  const shouldBlock = Boolean(external && tabState.shouldBlock);
  if (external) {
    rememberRequestedExternal(details, shouldBlock);
  }

  return shouldBlock ? { cancel: true } : {};
}

try {
  ext.webRequest.onBeforeRequest.addListener(
    handleBeforeRequest,
    { urls: ["<all_urls>"] },
    ["blocking"]
  );
} catch (error) {
  console.warn("[DeWeb Shield] Blocking webRequest unavailable, using passive request tracking:", error);
  ext.webRequest.onBeforeRequest.addListener(
    handleBeforeRequest,
    { urls: ["<all_urls>"] }
  );
}

ext.webRequest.onErrorOccurred.addListener(recordExternalRequest, { urls: ["<all_urls>"] });
ext.webRequest.onHeadersReceived.addListener(
  recordMainFrameHeaders,
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["responseHeaders"]
);

Promise.all([
  loadProviderRegistryCache(),
  loadIntegrityCache()
])
  .then(() => refreshProviderRegistry(false))
  .catch(console.error);

if (ext.runtime.onInstalled) {
  ext.runtime.onInstalled.addListener(() => {
    refreshProviderRegistry(true).catch(console.error);
  });
}

if (ext.runtime.onStartup) {
  ext.runtime.onStartup.addListener(() => {
    refreshProviderRegistry(false).catch(console.error);
  });
}

if (ext.alarms) {
  ext.alarms.create("syncProviders", { periodInMinutes: DEFAULT_SETTINGS.providerSyncIntervalHours * 60 });
  ext.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "syncProviders") {
      refreshProviderRegistry(true).catch(console.error);
    }
  });
}

async function handleRuntimeMessage(message, sender) {
  const tabId = sender.tab?.id ?? message.tabId;
  const messageType = message.type;

  if (messageType === "PAGE_REPORT" && tabId !== undefined) {
    await refreshTabPolicy(tabId, message.report.url);
    pageReportByTab.set(tabId, message.report);
    const settings = await getSettings();
    const trustedProviders = await getMergedTrustedProviders();
    const detection = detectDeWeb(message.report.url, trustedProviders);
    const cspValue = cspHeaderByTab.get(tabId) || message.report.cspMeta || "";
    const csp = summarizeCsp(cspValue);
    const previous = getTabState(tabId);
    const shouldBlock = detection.isDeWeb && settings.blockExternalCalls && !previous.whitelisted;
    const networkRequests = externalLogByTab.get(tabId) || [];
    const externalLinks = normalizeExternalLinks(message.report.externalLinks || message.report.externalRequests || []);
    const providerTrusted = Boolean(findProviderMatch(detection.pageHost || detection.providerHost, trustedProviders));

    let next = setTabState(tabId, {
      ...detection,
      csp,
      providerTrusted,
      shouldBlock,
      externalDetected: externalLinks.slice(-200),
      externalDetectedCount: externalLinks.length,
      externalBlocked: shouldBlock ? networkRequests.filter((entry) => entry.blocked).length : 0,
      pageHash: message.report.documentHash,
      integrity: detection.isDeWeb ? "checking" : "unknown",
      integrityDetail: detection.isDeWeb ? "Checking trusted node..." : "Not detected as a DeWeb site.",
      integrityProgress: detection.isDeWeb ? { phase: "Queued", current: 0, total: 1, percent: 0 } : null
    });

    if (detection.isDeWeb && settings.trustedNodeUrl) {
      next = await compareWithTrustedNode(tabId, message.report);
    }

    return { ok: true, state: next };
  }

  if (messageType === "GET_POPUP_STATE") {
    const tabs = await tabsQuery({ active: true, currentWindow: true });
    const activeTab = tabs[0];
    if (activeTab?.id !== undefined && activeTab.url) {
      await refreshTabPolicy(activeTab.id, activeTab.url);
    }
    return {
      ok: true,
      state: activeTab?.id !== undefined ? getTabState(activeTab.id) : getTabState(-1),
      settings: await getSettings()
    };
  }

  if (messageType === "GET_SETTINGS") {
    return {
      ok: true,
      settings: await getSettings(),
      providerRegistry: providerRegistryCache
    };
  }

  if (messageType === "RECHECK_INTEGRITY" || messageType === "FORCE_RECHECK_INTEGRITY" || messageType === "CHECK_INTEGRITY") {
    const tabs = await tabsQuery({ active: true, currentWindow: true });
    const activeTab = tabs[0];
    if (!activeTab?.id || !activeTab.url) {
      return { ok: false, error: "No active tab to check." };
    }

    await refreshTabPolicy(activeTab.id, activeTab.url);
    const current = getTabState(activeTab.id);
    if (!current.isDeWeb) {
      return { ok: true, state: current, settings: await getSettings() };
    }

    setTabState(activeTab.id, {
      integrity: "checking",
      integrityDetail: "Rechecking trusted node..."
    });

    const report = pageReportByTab.get(activeTab.id) || {
      url: activeTab.url,
      documentHash: ""
    };
    const next = await compareWithTrustedNode(activeTab.id, report, { force: true });
    return { ok: true, state: next, settings: await getSettings() };
  }

  if (messageType === "SAVE_SETTINGS") {
    await saveSettings(message.settings);
    await refreshProviderRegistry(true);
    const tabs = await tabsQuery({});
    await Promise.all(tabs
      .filter((tab) => tab.id !== undefined && tab.url)
      .map((tab) => refreshTabPolicy(tab.id, tab.url)));
    return { ok: true, settings: await getSettings() };
  }

  if (messageType === "SYNC_PROVIDERS") {
    const registry = await refreshProviderRegistry(true);
    return { ok: true, providerRegistry: registry };
  }

  if (messageType === "TOGGLE_SITE_WHITELIST") {
    const settings = await getSettings();
    const host = message.siteKey;
    const current = settings.whitelist[host] || {};
    const nextTrusted = !current.trustExternalCalls;
    settings.whitelist[host] = { ...current, trustExternalCalls: nextTrusted };
    await saveSettings(settings);
    const tabs = await tabsQuery({});
    const affectedTabs = tabs.filter((tab) => tab.id !== undefined && tab.url && getTabState(tab.id).siteKey === host);
    await Promise.all(affectedTabs.map(async (tab) => {
      externalLogByTab.delete(tab.id);
      setTabState(tab.id, {
        externalBlocked: 0,
        externalDetectedCount: 0,
        externalDetected: []
      });
      await refreshTabPolicy(tab.id, tab.url);
    }));
    await Promise.all(affectedTabs.map((tab) => reloadTab(tab.id).catch((error) => {
      console.warn("[DeWeb Shield] Could not reload trusted site tab:", error);
    })));
    return {
      ok: true,
      state: tabId !== undefined ? getTabState(tabId) : undefined,
      settings: await getSettings(),
      trusted: nextTrusted,
      reloaded: affectedTabs.length
    };
  }

  return { ok: false, error: `Unknown message type: ${messageType || "missing"}` };
}

if (usesPromiseApi) {
  ext.runtime.onMessage.addListener((message, sender) => {
    return handleRuntimeMessage(message, sender).catch((error) => {
      console.error(error);
      return { ok: false, error: error.message };
    });
  });
} else {
  ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleRuntimeMessage(message, sender)
      .then(sendResponse)
      .catch((error) => {
        console.error(error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  });
}
