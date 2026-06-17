const DEWEB_MNS = {
  mainnetChainId: 77658377,
  buildnetChainId: 77658366,
  mainnetAddress: "AS1q5hUfxLXNXLKsYQVXZLK7MPUZcWaNZZsK7e9QzqhGdAgLpUGT",
  buildnetAddress: "AS12qKAVjU1nr66JSkQ6N4Lqu4iwuVc6rAbRTrxFoynPrPdP1sj3G"
};

const DEWEB_STORAGE = {
  fileTag: "\x01FILE",
  fileLocationTag: "\x02LOCATION",
  chunkTag: "\x03CHUNK",
  chunkCountTag: "\x04CHUNK_NB"
};

const DEWEB_RPC = {
  maxGasCallSc: 4294167295,
  readOnlyCoins: "0.1",
  readOnlyFee: "0.1",
  batchSize: 64
};

function utf8Bytes(value) {
  return Array.from(new TextEncoder().encode(value));
}

function u32Bytes(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return Array.from(bytes);
}

function i32FromBytes(bytes) {
  const array = Uint8Array.from(bytes || []);
  if (array.length < 4) return 0;
  return new DataView(array.buffer, array.byteOffset, array.byteLength).getInt32(0, true);
}

function rpcBytes(value) {
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    return value.map((byte) => Number(byte) & 255);
  }

  if (value instanceof Uint8Array) {
    return Array.from(value);
  }

  if (typeof value === "object") {
    if (Array.isArray(value.data)) return rpcBytes(value.data);
    if (Array.isArray(value.value)) return rpcBytes(value.value);
  }

  if (typeof value === "string") {
    if (value === "") return [];

    try {
      const binary = atob(value);
      return Array.from(binary, (char) => char.charCodeAt(0));
    } catch (_error) {
      return utf8Bytes(value);
    }
  }

  return null;
}

function bytesToString(bytes) {
  return new TextDecoder().decode(Uint8Array.from(bytes || []));
}

function stringToBytes(value) {
  return new TextEncoder().encode(value);
}

function byteAt(bytes, index) {
  return index >= 0 && index < bytes.length ? bytes[index] : null;
}

function firstDifferentByte(left, right) {
  const max = Math.max(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    if (byteAt(left, index) !== byteAt(right, index)) return index;
  }
  return -1;
}

function looksText(bytes) {
  const sample = bytes.slice(0, Math.min(bytes.length, 512));
  if (sample.length === 0) return true;

  const suspicious = sample.filter((byte) => {
    return byte === 0 || byte < 9 || (byte > 13 && byte < 32);
  }).length;

  return suspicious / sample.length < 0.05;
}

function snippetAround(bytes, offset) {
  if (offset < 0 || !looksText(bytes)) return "";

  const start = Math.max(0, offset - 80);
  const end = Math.min(bytes.length, offset + 120);

  return bytesToString(bytes.slice(start, end))
    .replace(/\s+/g, " ")
    .slice(0, 220);
}

function visibleChar(byte) {
  if (byte === 10) return "\\n";
  if (byte === 13) return "\\r";
  if (byte === 9) return "\\t";
  if (byte === 32) return "␠";
  if (byte === null) return "∅";
  if (byte < 32 || byte > 126) return `\\x${byte.toString(16).padStart(2, "0")}`;
  return String.fromCharCode(byte);
}

function visibleSnippet(bytes, offset, radius = 60) {
  if (offset < 0) return "";

  const start = Math.max(0, offset - radius);
  const end = Math.min(bytes.length, offset + radius);

  return bytes
    .slice(start, end)
    .map(visibleChar)
    .join("");
}

function buildIntegrityDiff(providerBytes, onChainBytes, providerHash, onChainHash) {
  const firstDiffOffset = firstDifferentByte(providerBytes, onChainBytes);

  return {
    firstDiffOffset,
    providerHashShort: providerHash.slice(0, 16),
    onChainHashShort: onChainHash.slice(0, 16),
    providerSize: providerBytes.length,
    onChainSize: onChainBytes.length,

    providerSnippet: snippetAround(providerBytes, firstDiffOffset),
    onChainSnippet: snippetAround(onChainBytes, firstDiffOffset),

    providerVisibleSnippet: visibleSnippet(providerBytes, firstDiffOffset),
    onChainVisibleSnippet: visibleSnippet(onChainBytes, firstDiffOffset),

    providerByte: byteAt(providerBytes, firstDiffOffset),
    onChainByte: byteAt(onChainBytes, firstDiffOffset)
  };
}

function hasAll(value, needles) {
  return needles.every((needle) => value.includes(needle));
}

function stripDeWebInjectedStyle(html, report) {
  const pattern =
    /<!--\s*Injected DeWeb label style\s*-->\s*<style\b[^>]*>([\s\S]*?)<\/style>\s*<!--\s*Injected DeWeb label style\s*-->/i;

  const match = html.match(pattern);
  if (!match) {
    return html;
  }

  const styleContent = match[1];

  const valid = hasAll(styleContent, [
    ".massa-logo",
    ".massa-box",
    ".massa-box-content",
    ".massa-link",
    ".massa-on-chain-text",
    ".hide-button",
    ".massa-flex-content"
  ]);

  if (!valid) {
    report.valid = false;
    report.errors.push("Injected DeWeb style does not match the expected template.");
    return html;
  }

  report.removed.push("deweb-label-style");

  return html.replace(pattern, "</head>");
}

function stripDeWebInjectedStyleFallback(html, report) {
  if (report.removed.includes("deweb-label-style")) return html;

  const firstComment = html.search(/<!--\s*Injected DeWeb label style\s*-->/i);
  if (firstComment === -1) return html;

  const afterFirstComment = html.slice(firstComment).search(/<style\b[^>]*>/i);
  if (afterFirstComment === -1) return html;

  const styleStart = firstComment + afterFirstComment;
  const styleEndMatch = html.slice(styleStart).match(/<\/style>/i);

  if (!styleEndMatch || styleEndMatch.index === undefined) return html;

  const styleEnd = styleStart + styleEndMatch.index + styleEndMatch[0].length;
  const secondCommentMatch = html
    .slice(styleEnd)
    .match(/^\s*<!--\s*Injected DeWeb label style\s*-->/i);

  if (!secondCommentMatch) return html;

  const end = styleEnd + secondCommentMatch[0].length;
  const styleContent = html.slice(styleStart, styleEnd);

  const valid = hasAll(styleContent, [
    ".massa-logo",
    ".massa-box",
    ".massa-box-content",
    ".massa-link",
    ".massa-on-chain-text",
    ".hide-button",
    ".massa-flex-content"
  ]);

  if (!valid) {
    report.valid = false;
    report.errors.push("Injected DeWeb style fallback did not match the expected template.");
    return html;
  }

  report.removed.push("deweb-label-style");

  return `${html.slice(0, firstComment)}</head>${html.slice(end)}`;
}

function stripDeWebInjectedBox(html, report) {
  const marker = '<div class="massa-box" id="massaBox">';
  const start = html.indexOf(marker);

  if (start === -1) return html;

  const scriptStart = html.indexOf("<script", start);
  if (scriptStart === -1) {
    report.valid = false;
    report.errors.push("Injected DeWeb box is missing its close script.");
    return html;
  }

  const scriptEnd = html.indexOf("</script>", scriptStart);
  if (scriptEnd === -1) {
    report.valid = false;
    report.errors.push("Injected DeWeb box script is not closed.");
    return html;
  }

  let end = scriptEnd + "</script>".length;

  const closingBody = html.slice(end).match(/^\s*<\/body>/i);
  if (closingBody) {
    end += closingBody[0].length;
  }

  const injection = html.slice(start, end);

  const valid = hasAll(injection, [
    'id="massaBox"',
    "https://massa.net",
    "https://docs.massa.net/docs/deweb/home",
    "hosted on chain",
    "deweb-version",
    'id="closeMassaBoxBtn"',
    "massaBoxClosed",
    "closeMassaBox",
    "checkIfClosed"
  ]);

  if (!valid) {
    report.valid = false;
    report.errors.push("Injected DeWeb box does not match the expected template.");
    return html;
  }

  report.removed.push("deweb-label-box");

  let cleaned = html.slice(0, start) + html.slice(end);

  cleaned = cleaned
    .replace(/<body>\s*<body([^>]*)>/i, "<body$1>")
    .replace(/(<body[^>]*>)\s*(<div\b)/i, "$1\n$2");

  return cleaned;
}

function repairHeadCloseAfterDeWebStyle(html, report) {
  if (!report.removed.includes("deweb-label-style")) return html;
  if (/<\/head>\s*<body/i.test(html)) return html;

  const repaired = html.replace(/(<\/style>)\s*(<body\b)/i, "$1\n</head>\n$2");

  if (repaired !== html) {
    report.removed.push("deweb-head-close-repair");
  }

  return repaired;
}

function normalizeDeWebProviderHtml(providerBytes) {
  const report = {
    detected: false,
    applied: false,
    valid: true,
    removed: [],
    errors: []
  };

  if (!looksText(providerBytes)) {
    return { bytes: providerBytes, report };
  }

  let html = bytesToString(providerBytes);

  const hadMassaInjection =
    html.includes("massaBox") ||
    html.includes("Injected DeWeb label style") ||
    html.includes("hosted on chain");

  report.detected = hadMassaInjection;

  if (!hadMassaInjection) {
    return { bytes: providerBytes, report };
  }

  html = stripDeWebInjectedStyle(html, report);
  html = stripDeWebInjectedStyleFallback(html, report);
  html = stripDeWebInjectedBox(html, report);
  html = repairHeadCloseAfterDeWebStyle(html, report);

  html = html
    .replace(/<body>\s*<body([^>]*)>/i, "<body$1>")
    .replace(/(<body[^>]*>)\s*(<div\b)/i, "$1\n$2");

  report.applied = report.removed.length > 0;

  if (!report.applied) {
    report.valid = false;
    report.errors.push(
      "DeWeb server injection markers were found, but no known injection block could be normalized."
    );
  }

  return {
    bytes: stringToBytes(html),
    report
  };
}

function normalizeHtmlStructureWhitespace(bytes) {
  if (!looksText(bytes)) return bytes;

  let html = bytesToString(bytes);

  if (!/<\/head>/i.test(html) || !/<body\b/i.test(html)) {
    return bytes;
  }

  html = html
    // CRLF / CR -> LF
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")

    // Remove UTF-8 BOM if present
    .replace(/^\uFEFF/, "")

    // Remove trailing spaces/tabs
    .replace(/[ \t]+$/gm, "")

    // Fix DeWeb duplicated body case: <body><body ...>
    .replace(/<body>\s*<body([^>]*)>/i, "<body$1>")

    // Normalize </head> -> <body>
    .replace(/(<\/head>)\s*(<body\b[^>]*>)/i, "$1\n$2")

    // Normalize <body> -> first real tag
    .replace(/(<body\b[^>]*>)\s*(<(?!(?:\/|!|script|style)\b)[a-z][^>]*>)/i, "$1\n$2")

    // Normalize final document closing
    .replace(/(<\/[^>]+>)\s*(<\/body>)\s*(<\/html>)/i, "$1\n$2\n$3")

    // Normalize whitespace between pure HTML tags.
    // This targets provider formatting differences after DeWeb injection removal.
    .replace(/>\s+</g, ">\n<")

    // Avoid excessive blank lines
    .replace(/\n{3,}/g, "\n\n")

    // Stable final hash
    .trim();

  return stringToBytes(html);
}

function hasPrefix(bytes, prefix) {
  if (!bytes || bytes.length < prefix.length) return false;

  return prefix.every((byte, index) => bytes[index] === byte);
}

function concatBytes(...parts) {
  return parts.flatMap((part) => (Array.isArray(part) ? part : utf8Bytes(part)));
}

async function sha256Bytes(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest));
}

async function sha256Hex(value) {
  const digest = await sha256Bytes(value);

  return digest.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cleanResourcePath(urlValue) {
  const url = new URL(urlValue);

  let path = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!path) path = "index.html";

  return path;
}

function deriveMnsName(pageHost, providerHost) {
  const host = String(pageHost || "").toLowerCase();
  const provider = String(providerHost || "").toLowerCase();

  if (provider && host.endsWith(`.${provider}`)) {
    return host.slice(0, -(provider.length + 1));
  }

  if (host.endsWith(".massa")) {
    return host.slice(0, -".massa".length);
  }

  return host.split(".")[0] || host;
}

function mnsAddressForChain(chainId) {
  if (chainId === DEWEB_MNS.mainnetChainId) return DEWEB_MNS.mainnetAddress;
  if (chainId === DEWEB_MNS.buildnetChainId) return DEWEB_MNS.buildnetAddress;

  throw new Error(`Unsupported Massa chain id ${chainId || "unknown"}`);
}

async function massaRpc(nodeUrl, method, params) {
  const response = await fetch(nodeUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params
    })
  });

  if (!response.ok) {
    throw new Error(`${method} HTTP ${response.status}`);
  }

  const json = await response.json();

  if (json.error) {
    throw new Error(`${method}: ${json.error.message || JSON.stringify(json.error)}`);
  }

  return json.result;
}

async function getChainId(nodeUrl) {
  const status = await massaRpc(nodeUrl, "get_status");

  return Number(status.chain_id);
}

async function resolveMns(nodeUrl, mnsName) {
  const chainId = await getChainId(nodeUrl);
  const mnsAddress = mnsAddressForChain(chainId);

  const parameter = concatBytes(u32Bytes(mnsName.length), utf8Bytes(mnsName));

  const result = await massaRpc(nodeUrl, "execute_read_only_call", [
    [
      {
        max_gas: DEWEB_RPC.maxGasCallSc,
        coins: DEWEB_RPC.readOnlyCoins,
        fee: DEWEB_RPC.readOnlyFee,
        target_address: mnsAddress,
        target_function: "dnsResolve",
        parameter,
        caller_address: mnsAddress
      }
    ]
  ]);

  const call = result && result[0];

  if (!call || call.result?.Error) {
    throw new Error(call?.result?.Error || `MNS ${mnsName} did not resolve`);
  }

  const ok = call.result?.Ok || [];
  const resolved = bytesToString(rpcBytes(ok) || []);

  if (!resolved) {
    throw new Error(`MNS ${mnsName} resolved to an empty address`);
  }

  return resolved;
}

function datastoreEntry(address, key) {
  return { address, key };
}

async function getDatastoreEntries(nodeUrl, entries) {
  const result = await massaRpc(nodeUrl, "get_datastore_entries", [entries]);

  return (result || []).map((entry) => ({
    candidateValue: rpcBytes(entry.candidate_value),
    finalValue: rpcBytes(entry.final_value)
  }));
}

async function getDatastoreEntry(nodeUrl, address, key) {
  const entries = await getDatastoreEntries(nodeUrl, [datastoreEntry(address, key)]);

  return entries[0]?.finalValue || null;
}

async function getAddressInfo(nodeUrl, address) {
  const result = await massaRpc(nodeUrl, "get_addresses", [[address]]);

  return result && result[0] ? result[0] : null;
}

async function getOnChainFileList(nodeUrl, websiteAddress) {
  const addressInfo = await getAddressInfo(nodeUrl, websiteAddress);
  const prefix = utf8Bytes(DEWEB_STORAGE.fileLocationTag);

  const keys = (addressInfo?.final_datastore_keys || [])
    .map(rpcBytes)
    .filter((key) => hasPrefix(key, prefix));

  if (keys.length === 0) {
    return [];
  }

  const entries = await getDatastoreEntries(
    nodeUrl,
    keys.map((key) => datastoreEntry(websiteAddress, key))
  );

  return entries
    .map((entry) => (entry.finalValue ? bytesToString(entry.finalValue) : ""))
    .filter(Boolean)
    .sort();
}

async function fileHash(filePath) {
  return sha256Bytes(filePath);
}

async function fileChunkCountKey(filePath) {
  return concatBytes(
    DEWEB_STORAGE.fileTag,
    await fileHash(filePath),
    DEWEB_STORAGE.chunkCountTag
  );
}

async function fileChunkKey(filePath, index) {
  return concatBytes(
    DEWEB_STORAGE.fileTag,
    await fileHash(filePath),
    DEWEB_STORAGE.chunkTag,
    u32Bytes(index)
  );
}

async function getChunkCount(nodeUrl, websiteAddress, filePath) {
  const value = await getDatastoreEntry(
    nodeUrl,
    websiteAddress,
    await fileChunkCountKey(filePath)
  );

  if (!value) return null;

  return i32FromBytes(value);
}

async function fetchOnChainFile(nodeUrl, websiteAddress, filePath) {
  const chunkCount = await getChunkCount(nodeUrl, websiteAddress, filePath);

  if (!chunkCount) {
    throw new Error(`No on-chain chunks for ${filePath}`);
  }

  const keys = [];

  for (let index = 0; index < chunkCount; index += 1) {
    keys.push(await fileChunkKey(filePath, index));
  }

  const chunks = [];

  for (let start = 0; start < keys.length; start += DEWEB_RPC.batchSize) {
    const batch = keys.slice(start, start + DEWEB_RPC.batchSize);

    const entries = await getDatastoreEntries(
      nodeUrl,
      batch.map((key) => datastoreEntry(websiteAddress, key))
    );

    for (const entry of entries) {
      if (!entry.finalValue || entry.finalValue.length === 0) {
        throw new Error(`Empty on-chain chunk for ${filePath}`);
      }

      chunks.push(...entry.finalValue);
    }
  }

  return Uint8Array.from(chunks);
}

async function fetchOnChainFileWithFallback(nodeUrl, websiteAddress, requestedPath) {
  const candidates = [requestedPath];

  if (!requestedPath.endsWith(".html")) candidates.push(`${requestedPath}.html`);
  if (requestedPath !== "index.html") candidates.push("index.html");

  let lastError = null;

  for (const candidate of [...new Set(candidates)]) {
    try {
      return {
        filePath: candidate,
        bytes: await fetchOnChainFile(nodeUrl, websiteAddress, candidate)
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`No on-chain content for ${requestedPath}`);
}

async function fetchProviderBytes(urlValue) {
  const response = await fetch(urlValue, {
    cache: "no-store",
    credentials: "omit"
  });

  if (!response.ok) {
    throw new Error(`Provider HTTP ${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

function providerFileUrl(pageUrl, filePath) {
  const url = new URL(pageUrl);

  url.pathname = `/${filePath.replace(/^\/+/, "")}`;
  url.search = "";
  url.hash = "";

  return url.toString();
}

function normalizeProviderBytesForPath(providerBytes, filePath) {
  if (!filePath || typeof filePath !== "string") {
    return {
      bytes: providerBytes,
      injection: {
        detected: false,
        applied: false,
        valid: true,
        removed: [],
        errors: []
      }
    };
  }

  const normalized = filePath.endsWith(".html")
    ? normalizeDeWebProviderHtml(providerBytes)
    : {
        bytes: providerBytes,
        report: {
          detected: false,
          applied: false,
          valid: true,
          removed: [],
          errors: []
        }
      };

  return {
    bytes: filePath.endsWith(".html")
      ? normalizeHtmlStructureWhitespace(normalized.bytes)
      : normalized.bytes,
    injection: normalized.report
  };
}

function normalizeOnChainBytesForPath(onChainBytes, filePath) {
  if (!filePath || typeof filePath !== "string") {
    return onChainBytes;
  }

  return filePath.endsWith(".html")
    ? normalizeHtmlStructureWhitespace(onChainBytes)
    : onChainBytes;
}

async function compareFile(nodeUrl, websiteAddress, pageUrl, filePath) {
  if (!filePath || typeof filePath !== "string") {
    throw new Error("compareFile requires a valid filePath");
  }

  const providerBytes = await fetchProviderBytes(providerFileUrl(pageUrl, filePath));
  const onChainBytes = await fetchOnChainFile(nodeUrl, websiteAddress, filePath);

  const normalizedProvider = normalizeProviderBytesForPath(providerBytes, filePath);

  const providerCompareBytes = normalizedProvider.bytes;
  const onChainCompareBytes = normalizeOnChainBytesForPath(onChainBytes, filePath);

  const strictProviderHash = await sha256Hex(providerBytes);
  const strictOnChainHash = await sha256Hex(onChainBytes);

  const providerHash = await sha256Hex(providerCompareBytes);
  const onChainHash = await sha256Hex(onChainCompareBytes);

  const strictVerified = strictProviderHash === strictOnChainHash;
  const normalizedVerified = providerHash === onChainHash && normalizedProvider.injection.valid;

  return {
    filePath,

    // Backward-compatible field used by the UI.
    // This means "verified after trusted provider normalization".
    verified: normalizedVerified,

    strictVerified,
    normalizedVerified,

    strictProviderHash,
    strictOnChainHash,

    providerHash,
    onChainHash,

    providerSize: providerBytes.length,
    providerCompareSize: providerCompareBytes.length,

    onChainSize: onChainBytes.length,
    onChainCompareSize: onChainCompareBytes.length,

    injection: normalizedProvider.injection,

    diff: normalizedVerified
      ? null
      : buildIntegrityDiff(
          Array.from(providerCompareBytes),
          Array.from(onChainCompareBytes),
          providerHash,
          onChainHash
        )
  };
}

async function verifyDeWebIntegrity({ nodeUrl, pageUrl, pageHost, providerHost, onProgress = () => {} }) {
  onProgress({ phase: "Resolving MNS", current: 0, total: 1 });

  const mnsName = deriveMnsName(pageHost, providerHost);
  const websiteAddress = await resolveMns(nodeUrl, mnsName);
  const requestedPath = cleanResourcePath(pageUrl);

  onProgress({ phase: "Reading file list", current: 0, total: 1, mnsName, websiteAddress });

  const fileList = await getOnChainFileList(nodeUrl, websiteAddress);
  const filesToCheck = fileList.length > 0 ? fileList : [requestedPath];

  const fileResults = [];

  for (let index = 0; index < filesToCheck.length; index += 1) {
    const filePath = filesToCheck[index];
    onProgress({
      phase: "Checking files",
      current: index,
      total: filesToCheck.length,
      filePath,
      mnsName,
      websiteAddress
    });
    fileResults.push(await compareFile(nodeUrl, websiteAddress, pageUrl, filePath));
  }

  onProgress({
    phase: "Finalizing",
    current: filesToCheck.length,
    total: filesToCheck.length,
    mnsName,
    websiteAddress
  });

  const failed = fileResults.find((file) => !file.verified);
  const requestedResult =
    fileResults.find((file) => file.filePath === requestedPath) || fileResults[0];

  const representative = failed || requestedResult;
  const filesVerified = fileResults.filter((file) => file.verified).length;
  const verified = fileResults.length > 0 && filesVerified === fileResults.length;

  return {
    verified,

    mnsName,
    websiteAddress,

    requestedPath,
    onChainPath: representative.filePath,

    providerHash: representative.providerHash,
    onChainHash: representative.onChainHash,

    strictProviderHash: representative.strictProviderHash,
    strictOnChainHash: representative.strictOnChainHash,
    strictVerified: representative.strictVerified,
    normalizedVerified: representative.normalizedVerified,

    injection: representative.injection,
    diff: representative.diff,

    filesChecked: fileResults.length,
    filesVerified,

    failedFile: failed?.filePath || "",

    fileResults: fileResults.map((file) => ({
      filePath: file.filePath,
      verified: file.verified,
      strictVerified: file.strictVerified,
      normalizedVerified: file.normalizedVerified,
      providerHash: file.providerHash,
      onChainHash: file.onChainHash,
      strictProviderHash: file.strictProviderHash,
      strictOnChainHash: file.strictOnChainHash
    })),

    providerSize: representative.providerSize,
    providerCompareSize: representative.providerCompareSize,

    onChainSize: representative.onChainSize,
    onChainCompareSize: representative.onChainCompareSize
  };
}
