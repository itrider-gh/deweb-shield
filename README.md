# DeWeb Shield

DeWeb Shield is a Chromium Manifest V3 extension for Massa DeWeb browsing.

Security model:

- the browser loads the DeWeb site through the configured provider
- the extension lists external links referenced by the page code, monitors CSP, and checks integrity signals
- a trusted Massa node is configured as the source of truth for verification

Default trusted node:

```text
https://mainnet.massa.net/api/v2
```

<img width="1892" height="1033" alt="Capture d’écran 2026-06-17 161342" src="https://github.com/user-attachments/assets/5aee5d0e-d53c-4477-b3f9-8a2b505fa710" />


## Features

- Detects likely DeWeb pages through `.massa`, DeWeb provider hosts, and Massa query parameters.
- Blocks third-party resources on detected DeWeb sites through `declarativeNetRequest`.
- Lists external URLs referenced by the page DOM and inline code.
- Reads CSP from response headers and meta tags.
- Provides a popup status view:
  - site
  - provider
  - trusted node
  - integrity
  - external links found in code
  - CSP
- Provides settings for:
  - trusted node URL
  - provider registry URL
  - local-provider trust toggle
  - unknown-provider policy
  - external-call blocking
  - CSP warnings
  - automatic provider sync from GitHub
  - trusted providers
  - site whitelist

The local-provider toggle automatically adds `localhost`, `127.0.0.1`, and `::1` to trusted providers while keeping the GitHub registry and manual trusted providers active.

## Provider registry

Providers are synced automatically from:

```text
https://raw.githubusercontent.com/massalabs/DeWeb-Providers/main/providers.yaml
```

The extension caches the parsed provider hosts locally and refreshes them on install, startup, manual sync, and periodically every 12 hours by default. Manual trusted providers are merged with the GitHub registry.

## Trusted-node verification

The integrity check follows the official DeWeb server flow:

1. Extract the MNS name from the DeWeb subdomain.
2. Call the Massa MNS contract `dnsResolve` through the trusted node.
3. Resolve the website smart-contract address.
4. Rebuild the requested file from the DeWeb datastore chunks:
   - `[FILE_TAG][sha256(path)][CHUNK_NB_TAG]`
   - `[FILE_TAG][sha256(path)][CHUNK_TAG][chunk_index]`
5. Fetch the provider-served bytes for the current URL.
6. Compare `sha256(provider bytes)` with `sha256(on-chain bytes)`.

The extension uses the same MNS contracts as the DeWeb server:

- mainnet: `AS1q5hUfxLXNXLKsYQVXZLK7MPUZcWaNZZsK7e9QzqhGdAgLpUGT`
- buildnet: `AS12qKAVjU1nr66JSkQ6N4Lqu4iwuVc6rAbRTrxFoynPrPdP1sj3G`

Reference: https://github.com/massalabs/DeWeb/tree/main/server

## Install locally

Firefox:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click "Load Temporary Add-on".
3. Select deweb-shield/manifest.json.

Chromium:

1. Open `chrome://extensions`.
2. Enable developer mode.
3. Copy `manifest.chromium.json` to `manifest.json`.
4. Click "Load unpacked".
5. Select deweb-shield file.
