# dsh-budget-reader

A spend / budget widget for the [DeepSeek Harness](https://github.com/deepseek-ai) web GUI. It adds a small meter to the bottom of the left sidebar with your DeepSeek Platform balance and estimated spend; click it for a per-project breakdown, the live account card, and the price table.

> The repository is named `dsh-budget-reader`; the installable package inside is `dsh-cost-widget`. The package name is kept stable so existing installs keep working.

## What you get

- **Sidebar footer meter** — Platform balance (when signed in) and estimated spend. Collapsed sidebar shows a compact currency button.
- **Spend modal** — Platform wallets in their own currencies, optional real Platform spend, top-up / usage links, and a per-project breakdown that expands to individual sessions.
- **Accurate totals from session logs** — per-session token usage is folded from the durable session log, not just the in-process projection cache, so cold, older, and synced sessions still count.
- **Editable pricing** — USD per 1M tokens per model, a default model selector, and "reset to official prices".
- **Local and self-contained** — no runtime npm dependencies; configuration is a plain JSON file in the harness home.

## Requirements

- DeepSeek Harness with the **web** profile (`dsh web` or the desktop app).
- A DeepSeek account signed in under **Settings → Account** if you want the live Platform balance. The spend estimate works without it.
- For the recommended install: `dsh` on your `PATH` and `pnpm` available (the Harness bundles pnpm internally, but the CLI looks for one on `PATH`). If `dsh` reports `pnpm was not found`, install pnpm (`npm install -g pnpm`) or use the manual install below.

Tested with DSH 0.2.x (CLI `0.2.0-rc.2`, desktop app `0.2.1-rc.2`) on macOS.

## Install

### Recommended: install as a DSH bundle

```sh
dsh plugin --profile web add github:nielskrikke/dsh-budget-reader
```

This installs the package, adds it to the profile's bundle list, and activates the row from the package's own `cordis.patch.yml`. Restart the harness afterwards (`dsh web`, or quit and reopen the desktop app) so the client half is loaded in a fresh process.

If you prefer to install from a local clone:

```sh
git clone https://github.com/nielskrikke/dsh-budget-reader.git
dsh plugin --profile web add ./dsh-budget-reader
```

### Manual install

Use this when you do not want `dsh plugin` / pnpm to manage the package. The directory name must match the package name, `dsh-cost-widget`:

```sh
git clone https://github.com/nielskrikke/dsh-budget-reader.git \
  "$HOME/.dsh/profiles/web/dsh-cost-widget"

mkdir -p "$HOME/.dsh/profiles/web/node_modules"
ln -sfn ../dsh-cost-widget "$HOME/.dsh/profiles/web/node_modules/dsh-cost-widget"
```

Add this to `~/.dsh/profiles/web/cordis.patch.yml` (create the file with a top-level `[]` if it does not exist yet):

```yaml
- insert:
    - id: cost-widget
      name: dsh-cost-widget
      config: {}
```

Then restart the harness. Do **not** also select the package as a bundle: the bundle patch inserts the same row, and you would mount the widget twice.

On Windows the same layout works under `%USERPROFILE%\.dsh\profiles\web\`, but creating the `node_modules` link needs a junction or Developer Mode; using the `dsh plugin` route is easier there.

## Configuration

The widget reads and writes **`cost-widget.json` in the harness home**:

| Platform | Default path |
| --- | --- |
| macOS / Linux | `~/.dsh/cost-widget.json` |
| Windows | `%USERPROFILE%\.dsh\cost-widget.json` |

`$DSH_HOME` is honoured, so a harness home elsewhere uses `$DSH_HOME/cost-widget.json`. One file is shared by every profile (web, desktop, …), which keeps the widget consistent no matter how the harness was launched. The path can be overridden with the `DSH_COST_WIDGET_CONFIG` environment variable, or with `config.file` on the plugin row.

For a **bundle install**, override the row from the bundle (do not insert a second one):

```yaml
- id: cost-widget
  config:
    file: /absolute/path/to/cost-widget.json
```

For a **manual install**, put the same key in the `insert` entry's `config`.

A config written by an older install next to the package (`.../dsh-cost-widget/config.json`) is read once and migrated to the harness-home path. The config file is created on the first save from the widget; `config.example.json` shows the full shape:

```json
{
  "defaultModel": "deepseek-v4-flash",
  "prices": {
    "deepseek-v4-flash": {
      "input": 0.14,
      "cacheRead": 0.0028,
      "cacheWrite": 0,
      "output": 0.28
    },
    "deepseek-v4-pro": {
      "input": 0.435,
      "cacheRead": 0.003625,
      "cacheWrite": 0,
      "output": 0.87
    }
  },
  "internalCosts": false
}
```

- `defaultModel` — model key used to price sessions. The session list API has no per-session model, so every session is priced with this model's row unless you change it.
- `prices` — USD per 1M tokens. `cacheRead` is the cache-hit input price; `cacheWrite` is kept for providers that bill it (DeepSeek does not).
- `internalCosts` — opt-in read of the Platform's real cumulative spend. See below.

The modal edits this file directly through the host half; `localStorage` is only a mirror cache for when the route is unreachable. If both a browser and the file change at once, the file wins on the next refresh.

## Two numbers, never mixed

| | Source | Currency | Authority |
| --- | --- | --- | --- |
| **Balance left** | DeepSeek Platform account | CNY and/or USD, exactly as reported | Real |
| **Estimated spend** | provider-reported token usage × your price table | USD | Estimate |

Currencies are kept separate end to end: a CNY wallet is never added to a USD wallet, and the USD estimate is never subtracted from a Platform balance. The widget deliberately does not show a combined "remaining budget", because the Platform does not expose a single funded total and the estimate is not billing data.

## How the balance is fetched

Wallet balances and the top-up / usage links come from the first-party `deepseekAccount` service (`dsh-deepseek-account-platform`, part of `dsh-base`). That is the same seam the shipped Account settings page uses, so it already handles the PKCE grant, the Platform origin, client-identity headers, and token expiry. Amounts arrive as decimal strings so no server precision is lost in a float.

If the account is signed out, the account card says so and the estimate still works.

### Optional: real Platform spend

The first-party account response schema drops the Platform's `total_costs` field. With `"internalCosts": true`, the host half reads the stored account grant through the `credentials` service and queries the Platform's dashboard endpoint (`/api/v0/users/get_user_summary`) itself.

That endpoint is **undocumented**. The feature is therefore opt-in, fail-soft, and never replaces the estimate: if it fails, the widget shows the error and the estimate below it is unaffected. Leave it off if you do not want to depend on an internal API.

## How the estimate is computed

Costs are estimates: four disjoint token buckets (uncached input, cache read, cache write, output) priced at USD-per-1M-token rates.

The session list's own projections only cover sessions resident in the host process, or its projection cache, which is local to one machine. To count everything, the host half:

1. folds every durable session log with the same token-meter semantics the server uses;
2. serves per-session totals at `GET /api/dsh-cost-widget/summary` (cached per log size + mtime);
3. writes **`cost.summary.json`** next to each `session.jsonl.zstd` — a durable per-session record that travels with the session files.

The browser merges the live feed with that summary: live rows win for the running session, the log fold wins for every other session, and sessions missing from the live feed are added from the summary. The modal notes how many sessions came from the folded logs.

Projects are grouped by the Workspace whose path is the longest prefix of the session's working directory, falling back to the `cwd` basename, with sessions without a `cwd` under "Other". Subagent sessions are included and labeled. Everything is sorted by cost.

Official DeepSeek defaults — update these from [the pricing page](https://api-docs.deepseek.com/quick_start/pricing):

| Model | Input / 1M (cache miss) | Input / 1M (cache hit) | Output / 1M |
| --- | --- | --- | --- |
| `deepseek-v4-flash` | $0.14 | $0.0028 | $0.28 |
| `deepseek-v4-pro` | $0.435 | $0.003625 | $0.87 |

Peak / off-peak billing is not modeled. Bump the prices in the widget when your rates change.

## Optional external builder usage

If another local app chats with DeepSeek outside DSH, it can append one record per agent turn to `builder-usage.json` next to the package (or next to the installed package directory) and the widget will include it:

```json
{
  "records": [
    {
      "id": "turn-1",
      "source": "my-builder",
      "title": "Refactor session",
      "at": "2026-01-01T12:00:00Z",
      "cwd": "/Users/me/code/my-project",
      "model": "deepseek-v4-flash",
      "tokenUsage": {
        "uncachedInputTokens": 120000,
        "cacheReadTokens": 800000,
        "cacheWriteTokens": 0,
        "outputTokens": 30000
      }
    }
  ]
}
```

With no file the route returns an empty record list and nothing is added. This integration is optional; the widget is complete without it.

## Privacy and security

- Session logs are read **locally** to compute the estimate. The only file the plugin writes into session directories is `cost.summary.json`.
- The only network calls go to DeepSeek's Platform: the first-party account service, plus the optional undocumented `get_user_summary` call when `internalCosts` is enabled. The stored account token is read locally and sent only to the Platform origin derived from the account service's own links.
- No telemetry, analytics, or third-party endpoints.
- The widget's HTTP routes use the same loopback / same-origin trust fence as the core `/api` bridge. They reject a non-loopback `Host` header and cross-site browser requests.
- No credentials or tokens belong in this repository or in `cost-widget.json`.

## Troubleshooting

**The widget does not appear.**
Check that the row is in `cordis.patch.yml` (manual install) or that the bundle is selected (package install), then restart the process. Client code changes need a fresh process; editing the patch alone hot-reloads.

**The widget is mounted twice.**
You have both the bundle selected and a manual `insert` row. Keep one.

**The balance says "not signed in".**
Sign in under Settings → Account. The estimate does not depend on this.

**The estimate shows `$0` for old sessions.**
Open the modal once after a restart. The host folds the logs on demand and caches by size + mtime; the first fold can take a moment on a large session history.

**"Platform spend unavailable".**
`internalCosts` is on but the undocumented endpoint or the stored grant failed. The error is shown; the estimate is unaffected. Turn the opt-in off to hide it.

**Prices look wrong.**
Open the modal → Pricing, edit the four USD rates, or press "Reset to official prices". The file is written atomically.

## Development

The client bundle is plain JavaScript and can be SSR-rendered without a browser. `dev/harness.mjs` loads the real bundle, drives `apply()`, and renders the footer against live host data:

```sh
# React is not in the plugin tree; install it in a scratch directory.
mkdir -p /tmp/cw-deps
npm install --prefix /tmp/cw-deps react react-dom

DSH_HARNESS_DEPS=/tmp/cw-deps/node_modules \
DSH_URL=http://127.0.0.1:57636 \
node dev/harness.mjs
```

- `OPEN=1` renders with the modal open.
- `PLATFORM=1` injects the live Platform payload (requires a running, signed-in host).
- `DSH_NODE_MODULES` points at the DSH installation's `node_modules` when it is not in the default Homebrew location; if the primitives cannot be loaded the harness falls back to stubs.

There are no build steps, no bundler, and no runtime npm dependencies.

## Compatibility

The plugin uses the Web client module loader (`dsh.client`), the `sidebar.footer.action` slot, and the host's `webServer`, `deepseekAccount`, `credentials`, `sessionPersistence`, and `sessions` services. The client half imports `@deepseek-ai/dsh-client-ui-primitives` for the modal and button; if a future DSH release removes that private module, `client.js` needs a small local modal implementation. Everything else is plain JavaScript.

## License

MIT — see [LICENSE](LICENSE).
