/**
 * dsh-cost-widget — host half.
 *
 * Four jobs:
 *
 *  1. Serves the widget's pricing config over HTTP. The browser half talks to
 *     an exact route `/api/dsh-cost-widget/config` on the webServer service
 *     (GET read / PUT write), backed by a plain JSON file. By default the file
 *     is `$DSH_HOME/cost-widget.json` (`~/.dsh/cost-widget.json`), so a plugin
 *     update cannot overwrite it, every profile shares it, and harness homes
 *     that sync across machines carry the prices with them.
 *     `DSH_COST_WIDGET_CONFIG` or the plugin row's `config.file` can point
 *     somewhere else; the old package-local `config.json` is migrated on first
 *     read.
 *
 *     The route applies the same trust fence as the core `/api` bridge
 *     (loopback Host header + same-origin browser markers), and needs no
 *     changes to core packages — nothing for the auto-updater to wipe.
 *
 *  2. Serves an accurate, cross-device session cost summary:
 *       GET /api/dsh-cost-widget/summary
 *         -> { sessions: { <id>: { tokenUsage, asOfSeq, cwd, updatedAt } },
 *              computedAt }
 *     Totals are computed by folding the durable session log with the exact
 *     token-meter semantics (validated to match the server's own tokenUsage
 *     projections), so they do NOT depend on the projection cache
 *     (storages/session_projcache.json) — which only covers sessions resident
 *     in the process and is not part of the harness-home sync. Because the
 *     session logs themselves are portable, folding them anywhere yields the
 *     same totals: cold, older, and synced sessions all count.
 *
 *     Each folded session also gets a <session-dir>/cost.summary.json written
 *     next to its log, refreshed on every turn/end and whenever the summary is
 *     recomputed for a grown log — the durable per-session token record that
 *     travels with the session files, so any machine can read a session's
 *     totals straight from its directory.
 *
 *  3. Serves optional external builder-chat usage:
 *       GET /api/dsh-cost-widget/builder-usage
 *         -> { version, records: [{ source, title, at, cwd, model, tokenUsage }] }
 *     An external builder can append one record per agent turn to
 *     builder-usage.json next to this package, and its spend then shows up in
 *     the same widget. This is an optional integration; with no file the
 *     route simply returns an empty record list.
 *
 *  4. Serves the real DeepSeek Platform account snapshot:
 *       GET /api/dsh-cost-widget/platform?locale=<bcp47>&tzOffsetSeconds=<n>
 *         -> { fetchedAt, account: { status, links: { usageUrl, topUpUrl } },
 *              balance, totalCosts, costsError, stale? }
 *
 *     Two sources, deliberately separated:
 *
 *     a. Wallet balances + the top-up/usage links come from the FIRST-PARTY
 *        `deepseekAccount` service (dsh-deepseek-account-platform, part of
 *        dsh-base in every profile). That is the same seam the shipped
 *        Account settings page uses, and it already handles the PKCE grant,
 *        the Platform origin, client-identity headers and 401 expiry. It
 *        returns `normal_wallets` (top-ups) and `bonus_wallets` (granted
 *        credits) as `{ currency: 'CNY' | 'USD', balance: '<decimal string>' }`
 *        — amounts stay strings so no server precision is lost in a float.
 *
 *     b. Real cumulative spend is NOT exposed by that service: the Platform
 *        endpoint behind it (`/api/v0/users/get_user_summary`) also returns
 *        `total_costs`, but the service's response schema drops it. When
 *        `config.internalCosts` is on, this plugin reads the stored account
 *        grant through the `credentials` service and queries that dashboard
 *        endpoint itself. It is UNDOCUMENTED and may change without notice,
 *        so it is opt-in, fail-soft, and never replaces the token-usage
 *        estimate — it is reported alongside it as `totalCosts`.
 *
 *     The snapshot is cached for PLATFORM_CACHE_MS so the widget's polling
 *     cannot hammer the Platform, and a failed refresh serves the last good
 *     snapshot flagged `stale: true`.
 *
 * Defaults mirror the official DeepSeek price list (api-docs.deepseek.com —
 * deepseek-v4-flash / deepseek-v4-pro, flat rates until the peak/off-peak
 * switch). They are composition `base` values; the widget can override any
 * field and reset to these later.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";

export const name = "cost-widget";

/**
 * Client build version reported to the Platform for identity headers. The
 * first-party account client throws rather than send an empty version, so fall
 * back to a plausible constant when the harness package cannot be resolved.
 */
let CLIENT_VERSION = "0.0.0";
try {
  const requireFromHere = createRequire(import.meta.url);
  const resolved = requireFromHere("@deepseek-ai/dsh/package.json");
  if (resolved && typeof resolved.version === "string" && resolved.version !== "") CLIENT_VERSION = resolved.version;
} catch {
  /* keep the fallback: the header is identity metadata, not a gate */
}

/** Official defaults (the widget's "reset to official prices" target). */
export const COST_BASE = {
  defaultModel: "deepseek-v4-flash",
  prices: {
    "deepseek-v4-flash": { input: 0.14, cacheRead: 0.0028, cacheWrite: 0, output: 0.28 },
    "deepseek-v4-pro": { input: 0.435, cacheRead: 0.003625, cacheWrite: 0, output: 0.87 }
  },
  internalCosts: false
};

/**
 * The plugin's own directory (`lib/index.js` -> one level up).
 *
 * `config.json` here is the LEGACY location. It is still read (and migrated)
 * for installations made before the config moved to the harness home, but it is
 * no longer the default: a package installed under `node_modules` can be
 * replaced by an update, and pnpm may even hard-link it to a shared store.
 */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEGACY_CONFIG_FILE = join(PACKAGE_ROOT, "config.json");

/** The harness home (`$DSH_HOME`, default `~/.dsh`). */
const DSH_HOME =
  typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.trim() !== ""
    ? process.env.DSH_HOME
    : join(homedir(), ".dsh");

/**
 * Resolve the config file:
 *  1. the plugin row's `config.file` (tests / unusual layouts),
 *  2. `$DSH_COST_WIDGET_CONFIG`,
 *  3. `$DSH_HOME/cost-widget.json` (the normal case, shared by every profile),
 *  4. the legacy package-local `config.json`.
 *
 * A harness-home path is stable across plugin updates and works in both the
 * web and desktop profiles; a per-profile location would give the same install
 * two different configs depending on how the harness was launched.
 */
function resolveConfigFile(override) {
  if (typeof override === "string" && override.trim() !== "") return override;
  const fromEnv = process.env.DSH_COST_WIDGET_CONFIG;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
  return join(DSH_HOME, "cost-widget.json");
}

/** Route served to the browser half for the pricing config. */
const CONFIG_PATH = "/api/dsh-cost-widget/config";

/** Route served to the browser half for the session cost summary. */
const SUMMARY_PATH = "/api/dsh-cost-widget/summary";

/** Route served to the browser half for optional external builder usage. */
const BUILDER_USAGE_PATH = "/api/dsh-cost-widget/builder-usage";

/** Route served to the browser half for the DeepSeek Platform account snapshot. */
const PLATFORM_PATH = "/api/dsh-cost-widget/platform";

/**
 * Optional external-builder usage file: a builder appends one record per
 * agent turn here. Missing or unreadable means "no external usage".
 */
const BUILDER_USAGE_FILE = join(PACKAGE_ROOT, "builder-usage.json");

/** Max accepted PUT body (the file is a few hundred bytes; anything bigger is junk). */
const MAX_BODY_BYTES = 1024 * 1024;

/** Credential record holding the Platform account grant (read-only for us). */
const PLATFORM_CREDENTIAL_KEY = "deepseek-account-platform/default";

/** How long one Platform snapshot is reused before the next query. */
const PLATFORM_CACHE_MS = 60_000;

/** Per-request deadline for the undocumented dashboard call. */
const PLATFORM_TIMEOUT_MS = 10_000;

/** Server-side mirror of the client's field-level normalization. */
function normalizeConfig(parsed) {
  return {
    defaultModel: typeof parsed.defaultModel === "string" ? parsed.defaultModel : COST_BASE.defaultModel,
    prices: parsed.prices && typeof parsed.prices === "object" ? parsed.prices : COST_BASE.prices,
    internalCosts: parsed.internalCosts === true
  };
}

/** Write via temp file + rename so a crash or sync scan never sees a torn file. */
async function atomicWrite(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, file);
}

/**
 * Read one config file. Returns null when it is missing, unreadable, or not a
 * JSON object with the expected shape; the caller decides what that means.
 */
async function tryReadConfig(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return normalizeConfig(parsed);
  } catch {
    return null;
  }
}

/**
 * Read the effective config, migrating a legacy package-local file into the
 * resolved location on first use. Returns null when neither file exists.
 */
async function readStoredConfig(configFile) {
  const primary = await tryReadConfig(configFile);
  if (primary !== null) return primary;
  if (configFile === LEGACY_CONFIG_FILE) return null;
  const legacy = await tryReadConfig(LEGACY_CONFIG_FILE);
  if (legacy === null) return null;
  try {
    await atomicWrite(configFile, `${JSON.stringify(legacy, null, 2)}\n`);
  } catch {
    /* read-only location: still serve the legacy values */
  }
  return legacy;
}

/** Read the config file with defaults for a missing or corrupt file. */
async function readConfigFile(configFile) {
  return (
    (await readStoredConfig(configFile)) ?? {
      defaultModel: COST_BASE.defaultModel,
      prices: COST_BASE.prices,
      internalCosts: COST_BASE.internalCosts
    }
  );
}

/** Loopback hostname classification (localhost, [::1], 127/8) — mirrors the core /api fence. */
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * Trust fence for the widget routes, matching `isTrustedApiRequest` from
 * dsh-client-connection with no trustedHosts: the Host header must name the
 * loopback authority (DNS-rebinding defense), and any browser markers must be
 * same-origin (cross-site fetch defense). This deployment binds 127.0.0.1.
 */
function isTrustedRequest(req) {
  const host = req.headers.host;
  if (host === undefined) return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function sendJson(res, status, body) {
  const data = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(data)
  });
  res.end(data);
}

/** GET -> the config file (404 when not created yet); PUT -> validate + atomically store. */
async function handleConfig(req, res, configFile) {
  if (!isTrustedRequest(req)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  const method = req.method ?? "GET";
  if (method === "GET") {
    try {
      const stored = await readStoredConfig(configFile);
      if (stored === null) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      sendJson(res, 200, stored);
    } catch {
      sendJson(res, 500, { error: "read failed" });
    }
    return;
  }
  if (method === "PUT") {
    let body = "";
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413);
        res.end("payload too large");
        return;
      }
      body += chunk;
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end("body is not JSON");
      return;
    }
    if (parsed === null || typeof parsed !== "object") {
      res.writeHead(400);
      res.end("config must be an object");
      return;
    }
    try {
      const normalized = normalizeConfig(parsed);
      await atomicWrite(configFile, `${JSON.stringify(normalized, null, 2)}\n`);
      sendJson(res, 200, normalized);
    } catch {
      sendJson(res, 500, { error: "write failed" });
    }
    return;
  }
  res.writeHead(405);
  res.end();
}

/**
 * GET -> optional external-builder usage records. Missing or corrupt file =>
 * an empty record list; the widget treats builder usage as additive to session
 * spend.
 */
async function handleBuilderUsage(req, res, usageFile) {
  if (!isTrustedRequest(req)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const raw = await readFile(usageFile, "utf8");
    const parsed = JSON.parse(raw);
    const records = Array.isArray(parsed && parsed.records) ? parsed.records : [];
    sendJson(res, 200, { version: 1, records, computedAt: Date.now() });
  } catch {
    sendJson(res, 200, { version: 1, records: [], computedAt: Date.now() });
  }
}

// ---------------------------------------------------------------------------
// DeepSeek Platform account snapshot
// ---------------------------------------------------------------------------

/**
 * Accept the browser's UI language for the Platform identity headers. The
 * Platform reduces it to its two wire locales itself; anything that is not a
 * plausible language tag is replaced rather than forwarded.
 */
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;

/**
 * Build the request identity one account call carries. The browser supplies
 * the locale and UTC offset (only it knows the user's real ones); the version
 * is this plugin's view of the client build.
 */
function accountClientMetadata(searchParams) {
  const rawLocale = searchParams.get("locale");
  const locale = rawLocale !== null && LOCALE_PATTERN.test(rawLocale) ? rawLocale : "en-US";
  const rawOffset = Number(searchParams.get("tzOffsetSeconds"));
  const timezoneOffsetSeconds =
    Number.isFinite(rawOffset) && Math.abs(rawOffset) <= 16 * 3600 ? Math.trunc(rawOffset) : 0;
  return { version: CLIENT_VERSION, locale, timezoneOffsetSeconds };
}

/**
 * Project Platform wallet entries without trusting their shape: the dashboard
 * payload is undocumented, so anything that is not a recognized currency with
 * a decimal amount is dropped rather than rendered.
 * Wallet entries use `balance`; `total_costs` entries use `amount`.
 */
function projectWallets(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const { currency } = entry;
    const amount = entry.balance ?? entry.amount;
    if (currency !== "CNY" && currency !== "USD") continue;
    if (typeof amount !== "string" && typeof amount !== "number") continue;
    out.push({ currency, balance: String(amount) });
  }
  return out;
}

/**
 * Read the Platform's real cumulative spend. Requires `config.internalCosts`
 * because it uses an UNDOCUMENTED dashboard endpoint with the stored account
 * grant — the same record and token the first-party account service uses, read
 * through the `credentials` service and never written.
 * @returns `{ totalCosts, error }`; never throws, so a failure degrades to the
 * token-usage estimate instead of breaking the snapshot.
 */
async function readPlatformTotalCosts(scope, links) {
  let record;
  try {
    record = await scope.credentials.readRecord(PLATFORM_CREDENTIAL_KEY);
  } catch {
    return { totalCosts: null, error: "credential store unavailable" };
  }
  const token = record !== undefined && record.kind === "grant" ? record.payload?.token : undefined;
  if (typeof token !== "string" || token === "") return { totalCosts: null, error: "no stored account grant" };

  // Derive the Platform origin from the links the account service just gave
  // us, so the origin is never hardcoded (and never guessed from the token).
  let origin;
  try {
    origin = new URL(links.topUpUrl).origin;
  } catch {
    return { totalCosts: null, error: "platform origin unknown" };
  }

  let response;
  try {
    response = await fetch(`${origin}/api/v0/users/get_user_summary`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
      headers: {
        accept: "application/json",
        "x-dsh-auth-token": token,
        "x-client-platform": "web"
      }
    });
  } catch {
    return { totalCosts: null, error: "platform request failed" };
  }
  if (!response.ok) return { totalCosts: null, error: `platform HTTP ${response.status}` };

  let body;
  try {
    body = await response.json();
  } catch {
    return { totalCosts: null, error: "platform returned non-JSON" };
  }
  const biz = body?.data?.biz_data;
  if (biz === undefined || biz === null) {
    const code = body?.code;
    return { totalCosts: null, error: code === undefined || code === 0 ? "unexpected platform payload" : `platform code ${code}` };
  }
  return { totalCosts: projectWallets(biz.total_costs), error: null };
}

/** Last good Platform snapshot, reused for PLATFORM_CACHE_MS. */
let platformCache = null;

/**
 * Query the account service (and, when enabled, the dashboard endpoint) and
 * assemble one snapshot. A signed-out account is a normal, non-error outcome:
 * the widget still gets the links and simply shows no balances.
 */
async function readPlatformSnapshot(scope, configFile, client) {
  const state = await scope.deepseekAccount.getState();
  const snapshot = {
    fetchedAt: Date.now(),
    account: { status: state.status, links: state.links },
    balance: null,
    totalCosts: null,
    costsError: null
  };
  if (state.status !== "credential-stored") return snapshot;

  try {
    snapshot.balance = await scope.deepseekAccount.getBalance(client);
  } catch (error) {
    scope.logger.warn(`cost-widget: platform balance failed: ${String((error && error.message) || error)}`);
    snapshot.balance = { status: "failed" };
  }

  const config = await readConfigFile(configFile);
  if (config.internalCosts) {
    const costs = await readPlatformTotalCosts(scope, state.links);
    snapshot.totalCosts = costs.totalCosts;
    snapshot.costsError = costs.error;
  }
  return snapshot;
}

/**
 * Cached snapshot; a failed refresh serves the last good one flagged stale.
 * @param force - skip the cache read (the widget uses it right after the
 * `internalCosts` toggle changes what this snapshot contains).
 */
async function platformPayload(scope, configFile, client, force) {
  const now = Date.now();
  if (force !== true && platformCache !== null && now - platformCache.at < PLATFORM_CACHE_MS) {
    return platformCache.payload;
  }
  try {
    const payload = await readPlatformSnapshot(scope, configFile, client);
    platformCache = { at: now, payload };
    return payload;
  } catch (error) {
    const message = String((error && error.message) || error);
    scope.logger.warn(`cost-widget: platform snapshot failed: ${message}`);
    if (platformCache !== null) return { ...platformCache.payload, stale: true };
    return {
      fetchedAt: now,
      account: { status: "error", links: null },
      balance: null,
      totalCosts: null,
      costsError: message
    };
  }
}

async function handlePlatform(req, res, scope, configFile) {
  if (!isTrustedRequest(req)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const force = url.searchParams.get("fresh") === "1";
  sendJson(res, 200, await platformPayload(scope, configFile, accountClientMetadata(url.searchParams), force));
}

// ---------------------------------------------------------------------------
// Token-usage fold — exact replication of the token-meter projection
// (dsh-token-meter tokenUsageProjectionDefinition): cumulative provider
// usage, replacing a step's earlier sample instead of double counting.
// Validated to produce identical totals to the server's own projections.
// ---------------------------------------------------------------------------

function bucketsOf(usage) {
  return {
    uncachedInputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0
  };
}

function bucketsEqual(a, b) {
  return (
    a.uncachedInputTokens === b.uncachedInputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheWriteTokens === b.cacheWriteTokens
  );
}

function foldUsage(events) {
  const totals = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let last = null; // { turn, step, buckets }
  for (const event of events) {
    let turn;
    let step;
    let usage;
    if (event.type === "assistant/chunk" && event.data && event.data.chunk && event.data.chunk.type === "usage") {
      ({ turn, step } = event.data);
      usage = event.data.chunk.usage;
    } else if (event.type === "assistant/message" && event.data && event.data.usage !== undefined) {
      ({ turn, step, usage } = event.data);
    } else {
      continue;
    }
    const buckets = bucketsOf(usage);
    const previous = last !== null && last.turn === turn && last.step === step ? last.buckets : undefined;
    if (previous !== undefined && bucketsEqual(previous, buckets)) continue;
    if (previous !== undefined) {
      totals.uncachedInputTokens -= previous.uncachedInputTokens;
      totals.outputTokens -= previous.outputTokens;
      totals.cacheReadTokens -= previous.cacheReadTokens;
      totals.cacheWriteTokens -= previous.cacheWriteTokens;
    }
    totals.uncachedInputTokens += buckets.uncachedInputTokens;
    totals.outputTokens += buckets.outputTokens;
    totals.cacheReadTokens += buckets.cacheReadTokens;
    totals.cacheWriteTokens += buckets.cacheWriteTokens;
    last = { turn, step, buckets };
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Summary computation (cached per session by log size+mtime)
// ---------------------------------------------------------------------------

/** id -> { size, mtimeMs, value } */
const foldCache = new Map();
const FOLD_CACHE_MAX = 512;

/** Debounced eager refreshes keyed by session id (see the turn/end feed). */
const refreshTimers = new Map();

async function foldSession(persistence, header) {
  let location;
  try {
    location = persistence.locate(header);
  } catch {
    location = undefined;
  }
  let size = 0;
  let mtimeMs = 0;
  if (location) {
    try {
      const st = await stat(location.path);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      /* artifact may be mid-write or absent */
    }
  }
  const cached = foldCache.get(header.id);
  if (cached !== undefined && cached.size === size && cached.mtimeMs === mtimeMs) return cached.value;

  const { events } = await persistence.readFrom(header.id, 0);
  const tokenUsage = foldUsage(events);
  const last = events.length > 0 ? events[events.length - 1] : undefined;
  const value = {
    tokenUsage,
    asOfSeq: last !== undefined ? last.seq : -1,
    cwd: header.cwd,
    updatedAt: last !== undefined ? last.time : header.createdAt
  };
  foldCache.set(header.id, { size, mtimeMs, value });
  if (foldCache.size > FOLD_CACHE_MAX) {
    const first = foldCache.keys().next().value;
    foldCache.delete(first);
  }

  // Durable synced summary next to the log (fail-soft).
  if (location) {
    try {
      const target = dirname(location.path) + "/cost.summary.json";
      await writeFile(
        target,
        JSON.stringify({ sessionId: header.id, ...value, computedAt: Date.now() }, null, 2),
        "utf8"
      );
    } catch {
      /* non-fatal: the fold result still serves this request */
    }
  }
  return value;
}

async function computeSummary(ctx) {
  const persistence = ctx.sessionPersistence;
  const headers = await persistence.list();
  const sessions = {};
  for (const header of headers) {
    try {
      sessions[header.id] = await foldSession(persistence, header);
    } catch (error) {
      ctx.logger.warn(`cost-widget: summary for ${header.id} failed: ${String((error && error.message) || error)}`);
    }
  }
  return { sessions, computedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Plugin apply
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const configFile = resolveConfigFile(config.file);

  ctx.inject(["webServer"], (wsCtx) => {
    ctx.effect(
      () =>
        wsCtx.webServer.register({
          kind: "exact",
          path: CONFIG_PATH,
          handler: (req, res) => handleConfig(req, res, configFile)
        }),
      "cost-widget: config route"
    );
    ctx.effect(
      () =>
        wsCtx.webServer.register({
          kind: "exact",
          path: BUILDER_USAGE_PATH,
          handler: (req, res) => handleBuilderUsage(req, res, BUILDER_USAGE_FILE)
        }),
      "cost-widget: builder-usage route"
    );
  });

  // Platform snapshot: balances + links from the first-party account service,
  // plus the opt-in real-cost read (needs `credentials` for the account grant).
  ctx.inject(["deepseekAccount", "credentials", "webServer"], (platformCtx) => {
    platformCtx.effect(
      () =>
        platformCtx.webServer.register({
          kind: "exact",
          path: PLATFORM_PATH,
          handler: (req, res) => handlePlatform(req, res, platformCtx, configFile)
        }),
      "cost-widget: platform route"
    );
  });

  ctx.inject(["sessionPersistence", "webServer", "sessions"], (injected) => {
    // Summary route: fold every session's durable log on demand (cached by
    // log size+mtime) and serve the per-session token totals.
    injected.effect(
      () =>
        injected.webServer.register({
          kind: "exact",
          path: SUMMARY_PATH,
          handler: async (req, res) => {
            if (!isTrustedRequest(req)) {
              res.writeHead(403);
              res.end("forbidden");
              return;
            }
            try {
              const payload = await computeSummary(injected);
              sendJson(res, 200, payload);
            } catch (error) {
              sendJson(res, 500, { error: String((error && error.message) || error) });
            }
          }
        }),
      "cost-widget: summary route"
    );

    // Keep the synced cost.summary.json files current as chats grow: after a
    // turn ends, recompute that session's summary (debounced) so the file in
    // the synced session directory is always up to date.
    injected.effect(() => {
      const off = injected.on("session/event", (session, event) => {
        if (!event || event.type !== "turn/end") return;
        const id = session && session.id;
        if (id === undefined || refreshTimers.has(id)) return;
        const timer = setTimeout(async () => {
          refreshTimers.delete(id);
          try {
            const persistence = injected.sessionPersistence;
            const headers = await persistence.list();
            const header = headers.find((h) => h.id === id);
            if (header !== undefined) {
              foldCache.delete(id);
              await foldSession(persistence, header);
            }
          } catch (error) {
            injected.logger.warn(`cost-widget: eager summary refresh for ${id} failed: ${String((error && error.message) || error)}`);
          }
        }, 3000);
        if (typeof timer.unref === "function") timer.unref();
        refreshTimers.set(id, timer);
      });
      return () => {
        off();
        for (const timer of refreshTimers.values()) clearTimeout(timer);
        refreshTimers.clear();
      };
    }, "cost-widget: turn/end summary refresh");
  });
}
