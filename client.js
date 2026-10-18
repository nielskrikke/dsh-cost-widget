/**
 * dsh-cost-widget — browser half.
 *
 * Registers a footer action at the bottom of the left sidebar:
 *   - collapsed rail: a currency-symbol button
 *   - wide: the Platform balance plus the estimated spend beneath it
 * Clicking opens a modal with the Platform account (balances, real spend,
 * top-up link), a per-project spend breakdown, and the price table.
 *
 * Two independent numbers, deliberately never mixed:
 *
 *   1. PLATFORM BALANCE — real, authoritative, straight from the DeepSeek
 *      Platform via the host half's `/api/dsh-cost-widget/platform` route
 *      (wallets are decimal strings in CNY and/or USD). Shown in its own
 *      currency, exactly as the Platform reports it.
 *   2. ESTIMATED SPEND — `useSessions` rows carry
 *      `projectionValues.tokenUsage` ({ uncachedInputTokens, outputTokens,
 *      cacheReadTokens, cacheWriteTokens }) computed host-side from the
 *      durable session logs. Cost = tokens * USD-per-1M prices. The Platform
 *      exposes no per-session or per-model cost, so this stays the only
 *      per-project breakdown available.
 *
 * The session list's projections only cover sessions resident in the host
 * process (or its projection cache, which does not travel across machines), so
 * the widget ALSO fetches `/api/dsh-cost-widget/summary` — per-session totals
 * folded host-side from every available session log (token-meter-exact
 * semantics) — and merges the two: live rows win for the running session,
 * the log fold fills every other session, including cold, older, and
 * synced-from-another-machine ones.
 *
 * An external builder can chat with DeepSeek directly (not through DSH), so
 * that spend would otherwise be invisible here. Such a builder can append one
 * token-usage record per agent turn to a builder-usage.json file, served back
 * by the host half at `/api/dsh-cost-widget/builder-usage`; the widget merges
 * those records in as session-like rows (cwd = the builder repo), so they
 * group with DSH sessions. The integration is optional: with no records the
 * route returns an empty list and nothing changes.
 *
 * The Platform's real cumulative spend is available only through an
 * undocumented dashboard endpoint, so the host half reads it behind the
 * `internalCosts` opt-in; when it is on, this half shows it as a separate
 * "spent on the Platform" figure and never lets it replace the estimate.
 *
 * Config (prices + the opt-in flag) lives in a JSON file in the harness home
 * (`$DSH_HOME/cost-widget.json`, usually `~/.dsh/cost-widget.json`),
 * read/written through the host half's `/api/dsh-cost-widget/config` route. A
 * harness home that syncs across machines therefore carries the prices with
 * it, and every profile shares the same config. localStorage keeps a mirror
 * cache + migrates a legacy config into the file on first run. The
 * settings-service seam is intentionally NOT used: the web apiproxy only
 * exposes namespaces on a hardcoded allowlist (see WEB_SETTINGS_NAMESPACES in
 * dsh-host-apiproxy), so a third-party plugin cannot self-expose a namespace
 * without patching core packages that auto-updates would wipe.
 */
window.__ModuleLoader__.load({
  id: "dsh-cost-widget",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // ---- platform imports (seed words only) ----
    const React = require("react");
    const { useState, useEffect, useMemo, useCallback, useRef } = React;
    const { jsx, jsxs, Fragment } = require("react/jsx-runtime");
    const { Modal, Button } = require("@deepseek-ai/dsh-client-ui-primitives");

    // ------------------------------------------------------------------
    // Config (host-file backed)
    // ------------------------------------------------------------------

    const STORAGE_KEY = "dsh-cost-widget.config.v1";
    const CONFIG_URL = "/api/dsh-cost-widget/config";
    const SUMMARY_URL = "/api/dsh-cost-widget/summary";
    const BUILDER_USAGE_URL = "/api/dsh-cost-widget/builder-usage";
    const PLATFORM_URL = "/api/dsh-cost-widget/platform";

    /**
     * USD per 1M tokens, keyed by model id. Defaults mirror the official
     * DeepSeek price list (api-docs.deepseek.com/quick_start/pricing — keep in
     * sync with that table; flat rates until the peak/off-peak switch).
     */
    const DEFAULT_PRICES = {
      "deepseek-v4-flash": { input: 0.14, cacheRead: 0.0028, cacheWrite: 0, output: 0.28 },
      "deepseek-v4-pro": { input: 0.435, cacheRead: 0.003625, cacheWrite: 0, output: 0.87 },
      "deepseek-chat": { input: 0.28, cacheRead: 0.028, cacheWrite: 0, output: 0.42 }
    };
    const DEFAULT_MODEL = "deepseek-v4-flash";
    const DEFAULT_CONFIG = { defaultModel: DEFAULT_MODEL, prices: DEFAULT_PRICES, internalCosts: false };

    /** Field-level normalization shared by file and localStorage reads. */
    function normalizeConfig(parsed) {
      return {
        defaultModel: typeof parsed.defaultModel === "string" ? parsed.defaultModel : DEFAULT_MODEL,
        prices: parsed.prices && typeof parsed.prices === "object" ? parsed.prices : DEFAULT_PRICES,
        internalCosts: parsed.internalCosts === true
      };
    }

    function readLocalCache() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        return normalizeConfig(JSON.parse(raw));
      } catch {
        return null;
      }
    }

    function writeLocalCache(cfg) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
      } catch {}
    }

    /**
     * Read the synced config file via the host route.
     * Resolves: config object | null (no file yet) | undefined (route
     * unreachable — e.g. a client-only dev harness without the host half).
     */
    async function fetchFileConfig() {
      let res;
      try {
        res = await fetch(CONFIG_URL, { method: "GET", headers: { accept: "application/json" }, cache: "no-store" });
      } catch {
        return undefined;
      }
      if (res.status === 404) return null;
      if (!res.ok) return undefined;
      try {
        return normalizeConfig(await res.json());
      } catch {
        return undefined;
      }
    }

    /** Write the config to the synced file. Throws when the write fails. */
    async function saveFileConfig(cfg) {
      const res = await fetch(CONFIG_URL, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cfg)
      });
      if (!res.ok) throw new Error("config write failed: " + res.status);
    }

    /**
     * Load the widget config. The synced file is the source of truth; the
     * localStorage cache covers the case where the route is unreachable, and
     * a legacy localStorage config migrates into the file on first run so an
     * existing config survives and starts syncing.
     */
    async function loadConfig() {
      const fromFile = await fetchFileConfig();
      if (fromFile) return fromFile;
      if (fromFile === null) {
        const legacy = readLocalCache();
        if (legacy) {
          try {
            await saveFileConfig(legacy);
          } catch {}
          return legacy;
        }
        return { ...DEFAULT_CONFIG };
      }
      return readLocalCache() || { ...DEFAULT_CONFIG };
    }

    // ------------------------------------------------------------------
    // DeepSeek Platform account (balances, real spend, links)
    // ------------------------------------------------------------------

    /**
     * Fetch the Platform snapshot from the host half. The browser supplies its
     * own locale and UTC offset because only it knows the user's real ones.
     * @param force - bypass the host's short snapshot cache (after a toggle).
     * Resolves the parsed snapshot, or null when the route is unreachable.
     */
    async function fetchPlatform(force) {
      const params = new URLSearchParams();
      try {
        if (navigator && navigator.language) params.set("locale", navigator.language);
      } catch {}
      try {
        params.set("tzOffsetSeconds", String(-new Date().getTimezoneOffset() * 60));
      } catch {}
      if (force) params.set("fresh", "1");
      let res;
      try {
        res = await fetch(PLATFORM_URL + "?" + params.toString(), {
          headers: { accept: "application/json" },
          cache: "no-store"
        });
      } catch {
        return null;
      }
      if (!res.ok) return null;
      try {
        const data = await res.json();
        return data && data.account ? data : null;
      } catch {
        return null;
      }
    }

    function walletSymbol(currency) {
      return currency === "CNY" ? "\u00a5" : "$";
    }

    /** Render one Platform decimal string in its own currency, unmodified. */
    function fmtWallet(currency, amount) {
      const n = Number(amount);
      if (!Number.isFinite(n)) return walletSymbol(currency) + String(amount);
      return (
        walletSymbol(currency) +
        n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      );
    }

    /** Wallet rows for display: top-ups and granted credits kept separate. */
    function walletRows(balance) {
      if (!balance || balance.status !== "ready") return { topUp: [], bonus: [] };
      const clean = (list, dropZero) =>
        (Array.isArray(list) ? list : []).filter((w) => {
          if (!w || (w.currency !== "CNY" && w.currency !== "USD")) return false;
          const n = Number(w.balance);
          if (!Number.isFinite(n)) return false;
          return dropZero ? n !== 0 : true;
        });
      // Granted credits of exactly 0 are noise (the shipped Account page hides
      // them too); a zero top-up wallet is worth keeping — it means no funds.
      return { topUp: clean(balance.value, false), bonus: clean(balance.bonusWallets, true) };
    }

    /**
     * Sum wallets per currency for the headline. Currencies are never added
     * together: CNY and USD stay separate rows all the way to the UI.
     */
    function walletTotals(balance) {
      if (!balance || balance.status !== "ready") return [];
      const totals = new Map();
      for (const w of [...(balance.value || []), ...(balance.bonusWallets || [])]) {
        if (!w || (w.currency !== "CNY" && w.currency !== "USD")) continue;
        const n = Number(w.balance);
        if (!Number.isFinite(n)) continue;
        totals.set(w.currency, (totals.get(w.currency) || 0) + n);
      }
      return [...totals].map(([currency, total]) => ({ currency, total }));
    }

    /** Join the per-currency totals into one label, e.g. "\u00a5110.00 \u00b7 $4.00". */
    function walletLabel(totals) {
      if (!totals || totals.length === 0) return null;
      return totals.map((t) => fmtWallet(t.currency, String(t.total))).join(" \u00b7 ");
    }

    // ------------------------------------------------------------------
    // Session cost summary (synced log folds from the host half)
    // ------------------------------------------------------------------

    /**
     * Fetch per-session token totals folded from the synced session logs.
     * Resolves the parsed { sessions, computedAt } payload, or null when the
     * route is unreachable or returned nothing useful.
     */
    async function fetchSummary() {
      let res;
      try {
        res = await fetch(SUMMARY_URL, { headers: { accept: "application/json" }, cache: "no-store" });
      } catch {
        return null;
      }
      if (!res.ok) return null;
      try {
        const data = await res.json();
        return data && data.sessions ? data : null;
      } catch {
        return null;
      }
    }

    /**
     * Fetch optional external-builder usage records (written to
     * builder-usage.json by a builder integration). Resolves the parsed
     * { records } payload, or null when the route is unreachable.
     */
    async function fetchBuilderUsage() {
      let res;
      try {
        res = await fetch(BUILDER_USAGE_URL, { headers: { accept: "application/json" }, cache: "no-store" });
      } catch {
        return null;
      }
      if (!res.ok) return null;
      try {
        const data = await res.json();
        return data && Array.isArray(data.records) ? data : null;
      } catch {
        return null;
      }
    }

    /** Short human label for a builder source tag ("my-builder" -> "My Builder"). */
    function builderSourceLabel(source) {
      if (!source) return "External";
      return String(source)
        .replace(/[-_]+/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }

    /**
     * Turn external builder usage records into session-like rows and add them
     * to the merged rows map. Each record carries its own cwd (the builder
     * repo), so the existing project grouping (workspace match, else cwd
     * basename) puts them next to the DSH sessions.
     * Returns { rows, fromBuilder }.
     */
    function mergeBuilderRows(rows, records) {
      const next = { ...rows };
      let fromBuilder = 0;
      for (const rec of records || []) {
        if (!rec || !rec.tokenUsage) continue;
        const id = "builder:" + (rec.source || "builder") + ":" + rec.id;
        if (next[id]) continue;
        next[id] = {
          id,
          displayTitle: (rec.title || "Builder chat") + " \u00b7 " + builderSourceLabel(rec.source),
          cwd: rec.cwd,
          projectionValues: { tokenUsage: rec.tokenUsage }
        };
        fromBuilder += 1;
      }
      return { rows: next, fromBuilder };
    }

    /**
     * Merge the live session feed with the synced-log summary.
     * Feed rows win for RUNNING sessions (they carry live frames the fold has
     * not flushed yet); for every other session the synced fold wins when
     * present (a fresh full-log fold beats a possibly-stale cache row), and
     * sessions missing from the feed entirely are added from the summary.
     * Returns { rows, fromSummary } — fromSummary counts sessions whose
     * tokenUsage came from the synced logs.
     */
    function mergeRows(byId, summarySessions) {
      const rows = {};
      let fromSummary = 0;
      for (const s of Object.values(byId || {})) {
        const tu = s && s.projectionValues && s.projectionValues.tokenUsage;
        const extra = summarySessions ? summarySessions[s.id] : undefined;
        if (tu && s.running) {
          rows[s.id] = s; // live frames are freshest for the active session
        } else if (extra && extra.tokenUsage) {
          rows[s.id] = { ...s, projectionValues: { ...(s.projectionValues || {}), tokenUsage: extra.tokenUsage } };
          if (!tu) fromSummary += 1;
        } else {
          rows[s.id] = s;
        }
      }
      for (const [id, x] of Object.entries(summarySessions || {})) {
        if (rows[id] || !x || !x.tokenUsage) continue;
        rows[id] = { id, displayTitle: id.slice(0, 18), cwd: x.cwd, projectionValues: { tokenUsage: x.tokenUsage } };
        fromSummary += 1;
      }
      return { rows, fromSummary };
    }

    // ------------------------------------------------------------------
    // Pure cost engine
    // ------------------------------------------------------------------

    function priceOf(cfg, modelKey) {
      const prices = (cfg && cfg.prices) || DEFAULT_PRICES;
      return (
        prices[modelKey] ||
        DEFAULT_PRICES[modelKey] || // model not in the user's file yet -> official default
        prices[DEFAULT_MODEL] ||
        DEFAULT_PRICES[DEFAULT_MODEL]
      );
    }

    /** One session row -> { cost, tokens } in USD at the given price set. */
    function sessionCost(s, prices) {
      const tu = s && s.projectionValues && s.projectionValues.tokenUsage;
      if (!tu || !prices) return { cost: 0, tokens: 0 };
      const tokens =
        (tu.uncachedInputTokens || 0) +
        (tu.cacheReadTokens || 0) +
        (tu.cacheWriteTokens || 0) +
        (tu.outputTokens || 0);
      const cost =
        ((tu.uncachedInputTokens || 0) / 1e6) * prices.input +
        ((tu.cacheReadTokens || 0) / 1e6) * prices.cacheRead +
        ((tu.cacheWriteTokens || 0) / 1e6) * prices.cacheWrite +
        ((tu.outputTokens || 0) / 1e6) * prices.output;
      return { cost, tokens };
    }

    function basename(p) {
      if (!p) return "";
      const parts = String(p).replace(/[\\/]+$/, "").split(/[\\/]/);
      return parts[parts.length - 1] || p;
    }

    /**
     * Group sessions into projects. A session belongs to the Workspace whose
     * canonical path is the longest prefix of its cwd; without a Workspace
     * match it groups under its own cwd; sessions without a cwd go to "Other".
     * Returns projects sorted by cost, descending, each with its sessions
     * sorted by cost, descending.
     */
    function aggregate(sessionsById, workspaceItems, prices) {
      const sessions = Object.values(sessionsById || {});
      const wsByPath = new Map();
      for (const ws of workspaceItems || []) {
        if (ws && ws.path) wsByPath.set(ws.path, ws);
      }
      const wsForCwd = (cwd) => {
        if (!cwd) return null;
        let best = null;
        for (const [path, ws] of wsByPath) {
          if (cwd === path || cwd.startsWith(path.endsWith("/") ? path : path + "/")) {
            if (!best || path.length > best.path.length) best = { path, ws };
          }
        }
        return best;
      };
      const groups = new Map();
      for (const s of sessions) {
        const hit = wsForCwd(s.cwd);
        const key = hit ? `ws:${hit.ws.workspaceId}` : s.cwd ? `cwd:${s.cwd}` : "other";
        let g = groups.get(key);
        if (!g) {
          const name = hit
            ? hit.ws.title || basename(hit.ws.path)
            : s.cwd
              ? basename(s.cwd)
              : "Other";
          g = { key, name, cwd: hit ? hit.path : s.cwd, cost: 0, tokens: 0, count: 0, subagents: 0, sessions: [] };
          groups.set(key, g);
        }
        const sc = sessionCost(s, prices);
        g.cost += sc.cost;
        g.tokens += sc.tokens;
        g.count += 1;
        if (s.origin === "subagent") g.subagents += 1;
        g.sessions.push({ id: s.id, title: s.displayTitle || s.title || s.id, cwd: s.cwd, cost: sc.cost, tokens: sc.tokens, subagent: s.origin === "subagent" });
      }
      const projects = [...groups.values()];
      for (const g of projects) g.sessions.sort((a, b) => b.cost - a.cost);
      projects.sort((a, b) => b.cost - a.cost);
      return {
        projects,
        totalCost: projects.reduce((t, g) => t + g.cost, 0),
        totalTokens: projects.reduce((t, g) => t + g.tokens, 0),
        totalSessions: projects.reduce((t, g) => t + g.count, 0)
      };
    }

    function fmtUSD(n) {
      return n.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 4
      });
    }

    function fmtTokens(n) {
      if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
      return String(Math.round(n));
    }

    // ------------------------------------------------------------------
    // Styles (injected once, like the shipped bundles' CSS tags)
    // ------------------------------------------------------------------

    const CSS =
      ".dsw-cw-foot{display:flex;flex-direction:column;gap:2px;width:100%;padding:4px 8px;box-sizing:border-box;}" +
      ".dsw-cw-rail{display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;border:none;background:transparent;color:var(--dsw-text-2,#b8b8b8);cursor:pointer;font-size:15px;font-weight:600;}" +
      ".dsw-cw-rail:hover{background:rgba(128,128,128,.14);color:var(--dsw-text-1,#eee);}" +
      ".dsw-cw-trigger{display:flex;flex-direction:column;gap:3px;width:100%;padding:5px 8px;box-sizing:border-box;border:none;border-radius:8px;background:transparent;color:var(--dsw-text-2,#b8b8b8);cursor:pointer;text-align:left;}" +
      ".dsw-cw-trigger:hover{background:rgba(128,128,128,.14);}" +
      ".dsw-cw-line{display:flex;align-items:baseline;gap:5px;font-size:12px;line-height:1.3;}" +
      ".dsw-cw-spent{font-weight:700;color:var(--dsw-text-1,#eee);}" +
      ".dsw-cw-muted{color:var(--dsw-text-3,#8a8a8a);}" +
      ".dsw-cw-body{display:flex;flex-direction:column;gap:14px;padding:2px 2px 6px;}" +
      ".dsw-cw-stat{display:flex;justify-content:space-between;gap:10px;align-items:baseline;}" +
      ".dsw-cw-stat-label{font-size:12px;color:var(--dsw-text-3,#8a8a8a);}" +
      ".dsw-cw-stat-value{font-size:15px;font-weight:700;color:var(--dsw-text-1,#eee);}" +
      ".dsw-cw-stat-value-sm{font-size:13px;font-weight:600;color:var(--dsw-text-1,#eee);}" +
      ".dsw-cw-h{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-text-3,#8a8a8a);margin:2px 0 4px;}" +
      ".dsw-cw-card{display:flex;flex-direction:column;gap:8px;border:1px solid rgba(128,128,128,.18);border-radius:10px;padding:10px;}" +
      ".dsw-cw-actions{display:flex;gap:8px;flex-wrap:wrap;}" +
      ".dsw-cw-btn{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;text-decoration:none;padding:5px 10px;border-radius:7px;border:1px solid rgba(128,128,128,.3);color:var(--dsw-text-1,#eee);background:rgba(128,128,128,.1);cursor:pointer;}" +
      ".dsw-cw-btn:hover{background:rgba(128,128,128,.2);}" +
      ".dsw-cw-btn-primary{border-color:transparent;background:var(--dsw-accent,#4caf50);color:#06120a;}" +
      ".dsw-cw-btn-primary:hover{filter:brightness(1.08);}" +
      ".dsw-cw-proj{display:flex;flex-direction:column;gap:2px;border:1px solid rgba(128,128,128,.18);border-radius:10px;padding:6px 8px;}" +
      ".dsw-cw-proj-head{display:flex;align-items:center;gap:8px;width:100%;border:none;background:none;cursor:pointer;padding:2px 0;color:inherit;text-align:left;}" +
      ".dsw-cw-proj-name{font-size:13px;font-weight:600;color:var(--dsw-text-1,#eee);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
      ".dsw-cw-proj-cost{font-size:13px;font-weight:700;color:var(--dsw-text-1,#eee);}" +
      ".dsw-cw-proj-meta{font-size:11px;color:var(--dsw-text-3,#8a8a8a);}" +
      ".dsw-cw-sess{display:flex;gap:8px;align-items:baseline;padding:3px 2px 3px 12px;border-top:1px solid rgba(128,128,128,.1);}" +
      ".dsw-cw-sess-title{font-size:12px;color:var(--dsw-text-2,#c8c8c8);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
      ".dsw-cw-badge{font-size:9px;padding:0 5px;border-radius:6px;background:rgba(128,128,128,.2);color:var(--dsw-text-3,#8a8a8a);}" +
      ".dsw-cw-num{font-size:12px;color:var(--dsw-text-2,#c8c8c8);white-space:nowrap;}" +
      ".dsw-cw-settings{display:flex;flex-direction:column;gap:8px;border:1px solid rgba(128,128,128,.18);border-radius:10px;padding:10px;}" +
      ".dsw-cw-row{display:flex;align-items:center;gap:8px;}" +
      ".dsw-cw-label{font-size:12px;color:var(--dsw-text-2,#c8c8c8);width:120px;flex:none;}" +
      ".dsw-cw-input,.dsw-cw-select{flex:1;min-width:0;background:rgba(128,128,128,.1);border:1px solid rgba(128,128,128,.28);border-radius:7px;color:var(--dsw-text-1,#eee);font-size:12px;padding:4px 7px;}" +
      ".dsw-cw-input:focus,.dsw-cw-select:focus{outline:none;border-color:var(--dsw-accent,#5aa2ff);}" +
      ".dsw-cw-empty{font-size:12px;color:var(--dsw-text-3,#8a8a8a);padding:8px 2px;}" +
      ".dsw-cw-sync-warn{font-size:11px;line-height:1.4;color:#ffb300;border:1px solid rgba(255,179,0,.35);border-radius:8px;padding:6px 8px;}" +
      ".dsw-cw-note{font-size:11px;line-height:1.4;color:var(--dsw-text-3,#8a8a8a);}" +
      ".dsw-cw-check{display:flex;align-items:flex-start;gap:8px;cursor:pointer;}" +
      ".dsw-cw-check input{margin-top:2px;}" +
      ".dsw-cw-scroll{max-height:min(62vh,560px);overflow-y:auto;}" +
      ".dsw-cw-foot-rail{display:flex;justify-content:center;}";

    if (typeof document !== "undefined") {
      const tagId = "dsh-cost-widget/styles";
      if (!document.getElementById(tagId)) {
        const tag = document.createElement("style");
        tag.id = tagId;
        tag.dataset.plugin = "dsh-cost-widget";
        tag.dataset.pluginCss = tagId;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }
    }

    // ------------------------------------------------------------------
    // Components
    // ------------------------------------------------------------------

    /** One label/value stat row. */
    function Stat({ label, value, strong }) {
      return jsxs("div", {
        className: "dsw-cw-stat",
        children: [
          jsx("span", { className: "dsw-cw-stat-label", children: label }),
          jsx("span", { className: strong ? "dsw-cw-stat-value" : "dsw-cw-stat-value-sm", children: value })
        ]
      });
    }

    /** One expandable project row. */
    function ProjectRow({ project, open, onToggle }) {
      const meta = project.count + (project.subagents ? ` (${project.subagents} sub)` : "") + " \u00b7 " + fmtTokens(project.tokens) + " tok";
      return jsxs("div", {
        className: "dsw-cw-proj",
        children: [
          jsxs("button", {
            className: "dsw-cw-proj-head",
            onClick: onToggle,
            children: [
              jsx("span", { className: "dsw-cw-proj-name", title: project.cwd || project.name, children: project.name }),
              jsx("span", { className: "dsw-cw-proj-meta", children: meta }),
              jsx("span", { className: "dsw-cw-proj-cost", children: fmtUSD(project.cost) })
            ]
          }),
          open &&
            project.sessions.map((s) =>
              jsxs(
                "div",
                {
                  className: "dsw-cw-sess",
                  children: [
                    jsx("span", { className: "dsw-cw-sess-title", title: s.cwd || s.title, children: s.title }),
                    s.subagent && jsx("span", { className: "dsw-cw-badge", children: "subagent" }),
                    jsx("span", { className: "dsw-cw-num", children: fmtTokens(s.tokens) + " tok" }),
                    jsx("span", { className: "dsw-cw-num", children: fmtUSD(s.cost) })
                  ]
                },
                s.id
              )
            )
        ]
      });
    }

    /** Platform account card: real balances, real spend, and the links out. */
    function PlatformCard({ platform, cfg, onConfig }) {
      const account = platform && platform.account;
      const status = account ? account.status : "unavailable";
      const links = (account && account.links) || null;
      const rows = walletRows(platform && platform.balance);
      const totals = walletTotals(platform && platform.balance);
      const costs = (platform && platform.totalCosts) || null;
      const costsEnabled = !!(cfg && cfg.internalCosts);

      const balanceValue =
        status === "credential-stored"
          ? walletLabel(totals) || "no balance reported"
          : status === "signed-out"
            ? "not signed in"
            : "\u2014";

      return jsxs("div", {
        className: "dsw-cw-card",
        children: [
          jsxs("div", {
            className: "dsw-cw-actions",
            children: [
              links && links.topUpUrl
                ? jsx("a", {
                    className: "dsw-cw-btn dsw-cw-btn-primary",
                    href: links.topUpUrl,
                    target: "_blank",
                    rel: "noreferrer",
                    children: "Top up balance"
                  })
                : null,
              links && links.usageUrl
                ? jsx("a", {
                    className: "dsw-cw-btn",
                    href: links.usageUrl,
                    target: "_blank",
                    rel: "noreferrer",
                    children: "Usage on the Platform"
                  })
                : null
            ]
          }),
          jsx(Stat, { label: "Balance left (Platform)", value: balanceValue, strong: true }),
          costsEnabled &&
            jsx(Stat, {
              label: "Spent (Platform)",
              value: costs && costs.length > 0 ? walletLabel(costs.map((c) => ({ currency: c.currency, total: Number(c.balance) }))) : costs ? "not reported" : "\u2014"
            }),
          rows.topUp.length > 0 &&
            jsxs(Fragment, {
              children: [
                jsx("div", { className: "dsw-cw-h", children: "Top-up balance" }),
                rows.topUp.map((w) =>
                  jsx(Stat, { label: w.currency, value: fmtWallet(w.currency, w.balance) }, "topup-" + w.currency)
                )
              ]
            }),
          rows.bonus.length > 0 &&
            jsxs(Fragment, {
              children: [
                jsx("div", { className: "dsw-cw-h", children: "Granted credits" }),
                rows.bonus.map((w) =>
                  jsx(Stat, { label: w.currency, value: fmtWallet(w.currency, w.balance) }, "bonus-" + w.currency)
                )
              ]
            }),
          status === "signed-out" &&
            jsx("div", {
              className: "dsw-cw-note",
              children: "Sign in to your DeepSeek account in Settings \u2192 Account to see balances and the top-up link here."
            }),
          platform && platform.stale &&
            jsx("div", { className: "dsw-cw-sync-warn", children: "Showing the last Platform snapshot \u2014 the latest refresh failed." }),
          costsEnabled &&
            platform &&
            platform.costsError &&
            jsx("div", {
              className: "dsw-cw-sync-warn",
              children: "Platform spend unavailable (" + platform.costsError + "). The estimate below is unaffected."
            }),
          jsxs("label", {
            className: "dsw-cw-check",
            children: [
              jsx("input", {
                type: "checkbox",
                checked: costsEnabled,
                onChange: () => onConfig({ internalCosts: !costsEnabled })
              }),
              jsxs("span", {
                className: "dsw-cw-note",
                children: [
                  jsx("strong", { children: "Read real Platform spend. " }),
                  "Uses DeepSeek's undocumented dashboard endpoint with your stored account token. It can break without notice; the estimate below always still works."
                ]
              })
            ]
          })
        ]
      });
    }

    /** Settings form: default model, price table, reset to official prices. */
    function SettingsForm({ cfg, onConfig }) {
      const prices = cfg.prices || {};
      const modelKeys = [...new Set([...(Object.keys(prices)), DEFAULT_MODEL])];
      const [model, setModel] = useState(cfg.defaultModel || DEFAULT_MODEL);
      const [form, setForm] = useState({ ...priceOf(cfg, model) });

      useEffect(() => {
        setModel(cfg.defaultModel || DEFAULT_MODEL);
      }, [cfg]);

      useEffect(() => {
        setForm({ ...priceOf(cfg, model) });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [model]);

      const commitPrices = (next) => {
        const nextPrices = { ...prices, [model]: { ...priceOf(cfg, model), ...next } };
        onConfig({ prices: nextPrices });
      };
      const num = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      };

      return jsxs("div", {
        className: "dsw-cw-settings",
        children: [
          jsx("div", { className: "dsw-cw-h", children: "Pricing" }),
          jsxs("div", {
            className: "dsw-cw-row",
            children: [
              jsx("span", { className: "dsw-cw-label", children: "Pricing model" }),
              jsx("select", {
                className: "dsw-cw-select",
                value: model,
                onChange: (e) => {
                  setModel(e.target.value);
                  onConfig({ defaultModel: e.target.value });
                },
                children: modelKeys.map((k) => jsx("option", { value: k, children: k }, k))
              })
            ]
          }),
          [
            ["input", "Input / 1M"],
            ["cacheRead", "Cache hit / 1M"],
            ["cacheWrite", "Cache write / 1M"],
            ["output", "Output / 1M"]
          ].map(([field, label]) =>
            jsxs(
              "div",
              {
                className: "dsw-cw-row",
                children: [
                  jsx("span", { className: "dsw-cw-label", children: label + " (USD)" }),
                  jsx("input", {
                    className: "dsw-cw-input",
                    type: "number",
                    min: 0,
                    step: "any",
                    value: form[field],
                    onChange: (e) => {
                      const v = num(e.target.value);
                      setForm((f) => ({ ...f, [field]: v }));
                      commitPrices({ [field]: v });
                    }
                  })
                ]
              },
              field
            )
          ),
          jsx("div", {
            className: "dsw-cw-row",
            children: jsx(Button, {
              variant: "ghost",
              size: "sm",
              onClick: () => onConfig({ prices: DEFAULT_PRICES, defaultModel: DEFAULT_MODEL }),
              children: "Reset to official prices"
            })
          })
        ]
      });
    }

    /** The breakdown modal body. */
    function Breakdown({ agg, cfg, onConfig, saveError, summaryNote, platform }) {
      const [openKeys, setOpenKeys] = useState({});
      const toggle = (key) => setOpenKeys((o) => ({ ...o, [key]: !o[key] }));

      return jsxs("div", {
        className: "dsw-cw-body",
        children: [
          jsx("div", { className: "dsw-cw-h", children: "DeepSeek Platform" }),
          jsx(PlatformCard, { platform, cfg, onConfig }),
          jsxs("div", {
            className: "dsw-cw-stat",
            children: [
              jsx("span", { className: "dsw-cw-stat-label", children: "Total spent (estimated)" }),
              jsx("span", { className: "dsw-cw-stat-value", children: fmtUSD(agg.totalCost) })
            ]
          }),
          jsx("div", {
            className: "dsw-cw-note",
            children:
              "DeepSeek publishes no per-session or per-model cost, so this is priced from provider-reported token usage with the table below \u2014 DSH sessions plus any external builder records you feed in."
          }),
          summaryNote && jsx("div", { className: "dsw-cw-sync-warn", children: summaryNote }),
          jsx("div", { className: "dsw-cw-h", children: "By project (" + agg.totalSessions + " sessions, " + fmtTokens(agg.totalTokens) + " tokens)" }),
          agg.projects.length === 0
            ? jsx("div", { className: "dsw-cw-empty", children: "No session cost data yet \u2014 totals appear as soon as the first model call reports usage." })
            : agg.projects.map((p) => jsx(ProjectRow, { project: p, open: !!openKeys[p.key], onToggle: () => toggle(p.key) }, p.key)),
          jsx(SettingsForm, { cfg, onConfig }),
          saveError &&
            jsx("div", {
              className: "dsw-cw-sync-warn",
              children:
                "Could not write the config file \u2014 changes are kept in this browser only and won't sync to your other machine. Check that the harness home is writable."
            })
        ]
      });
    }

    /** Sidebar foot action: the trigger + modal. */
    function CostFooter({ wide, useSessions, useWorkspaces }) {
      const sessions = useSessions((st) => st.byId);
      const workspaces = useWorkspaces((st) => st.items);
      const [open, setOpen] = useState(false);
      const [cfg, setCfg] = useState(null); // null = still loading the synced file
      const [saveError, setSaveError] = useState(false);
      const [summary, setSummary] = useState(null); // { sessions } from the host fold
      const [builderUsage, setBuilderUsage] = useState(null); // { records } from the builders
      const [platform, setPlatform] = useState(null); // Platform snapshot from the host half
      const savingRef = useRef(false);
      const refreshSeq = useRef(0);
      const summarySeq = useRef(0);
      const builderSeq = useRef(0);
      const platformSeq = useRef(0);

      /** Save a config patch to the synced file (mirrored to localStorage). */
      const onConfig = useCallback(async (patch) => {
        const next = { ...(cfg || DEFAULT_CONFIG), ...patch };
        savingRef.current = true;
        refreshSeq.current += 1; // a save supersedes any in-flight refresh
        setCfg(next);
        setSaveError(false);
        writeLocalCache(next);
        try {
          await saveFileConfig(next);
        } catch {
          setSaveError(true); // file write failed — the localStorage mirror still holds it
        } finally {
          savingRef.current = false;
        }
      }, [cfg]);

      /** Re-read the synced file (mount, modal open, focus, periodic poll). */
      const refresh = useCallback(async () => {
        if (savingRef.current) return; // don't clobber a save that is in flight
        const seq = ++refreshSeq.current;
        const loaded = await loadConfig();
        if (seq !== refreshSeq.current) return; // superseded by a newer refresh/save
        setCfg(loaded);
      }, []);

      useEffect(() => {
        refresh();
      }, [refresh]);

      useEffect(() => {
        const t = setInterval(refresh, 30000);
        return () => clearInterval(t);
      }, [refresh]);

      useEffect(() => {
        const onVisible = () => {
          if (typeof document === "undefined" || !document.addEventListener) return;
          if (document.visibilityState === "visible") refresh();
        };
        const onFocus = () => refresh();
        if (typeof window !== "undefined" && window.addEventListener) window.addEventListener("focus", onFocus);
        if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("visibilitychange", onVisible);
        return () => {
          if (typeof window !== "undefined" && window.removeEventListener) window.removeEventListener("focus", onFocus);
          if (typeof document !== "undefined" && document.removeEventListener) document.removeEventListener("visibilitychange", onVisible);
        };
      }, [refresh]);

      /** Load the synced-log summary (superseded loads are dropped). */
      const loadSummary = useCallback(async () => {
        const seq = ++summarySeq.current;
        const data = await fetchSummary();
        if (seq !== summarySeq.current) return;
        setSummary(data);
      }, []);

      useEffect(() => {
        loadSummary();
        const t = setInterval(loadSummary, 30000);
        return () => clearInterval(t);
      }, [loadSummary]);

      /** Load the builders' usage records (superseded loads are dropped). */
      const loadBuilderUsage = useCallback(async () => {
        const seq = ++builderSeq.current;
        const data = await fetchBuilderUsage();
        if (seq !== builderSeq.current) return;
        setBuilderUsage(data);
      }, []);

      useEffect(() => {
        loadBuilderUsage();
        const t = setInterval(loadBuilderUsage, 30000);
        return () => clearInterval(t);
      }, [loadBuilderUsage]);

      /** Load the Platform snapshot; `force` bypasses the host's short cache. */
      const loadPlatform = useCallback(async (force) => {
        const seq = ++platformSeq.current;
        const data = await fetchPlatform(force === true);
        if (seq !== platformSeq.current) return;
        setPlatform(data);
      }, []);

      useEffect(() => {
        loadPlatform(false);
        const t = setInterval(() => loadPlatform(false), 60000);
        return () => clearInterval(t);
      }, [loadPlatform]);

      /** Flip the opt-in and re-read immediately (the toggle changes the query). */
      const onPlatformConfig = useCallback(
        async (patch) => {
          await onConfig(patch);
          if (patch && patch.internalCosts !== undefined) loadPlatform(true);
        },
        [onConfig, loadPlatform]
      );

      const openModal = () => {
        setOpen(true);
        refresh();
        loadSummary();
        loadBuilderUsage();
        loadPlatform(true);
      };

      const c = cfg || DEFAULT_CONFIG;
      const prices = priceOf(c, c.defaultModel || DEFAULT_MODEL);
      const merged = useMemo(() => {
        const base = mergeRows(sessions, summary && summary.sessions);
        const withBuilder = mergeBuilderRows(base.rows, builderUsage && builderUsage.records);
        return { rows: withBuilder.rows, fromSummary: base.fromSummary, fromBuilder: withBuilder.fromBuilder };
      }, [sessions, summary, builderUsage]);
      const agg = useMemo(() => aggregate(merged.rows, workspaces, prices), [merged, workspaces, prices]);
      const noteParts = [];
      if (merged.fromSummary > 0) {
        noteParts.push(
          "Including " + merged.fromSummary + " session(s) folded from the synced session logs (cold / synced from another machine)."
        );
      }
      if (merged.fromBuilder > 0) {
        noteParts.push(
          "Including " + merged.fromBuilder + " external builder chat turn(s)."
        );
      }
      const summaryNote = noteParts.length > 0 ? noteParts.join(" ") : null;

      const spent = agg.totalCost;
      const totals = walletTotals(platform && platform.balance);
      const balance = walletLabel(totals);
      const title =
        (balance ? balance + " left \u00b7 " : "") +
        "estimated spend " + fmtUSD(spent) +
        " \u2014 click for the Platform and per-project breakdown";

      const trigger = wide
        ? jsxs("button", {
            className: "dsw-cw-trigger",
            title: title,
            onClick: openModal,
            children: [
              jsxs("span", {
                className: "dsw-cw-line",
                children: [
                  jsx("span", { className: "dsw-cw-spent", children: balance || fmtUSD(spent) }),
                  jsx("span", { className: "dsw-cw-muted", children: balance ? "left" : "estimated" })
                ]
              }),
              jsx("span", {
                className: "dsw-cw-line",
                children: jsx("span", {
                  className: "dsw-cw-muted",
                  children: balance ? "est. " + fmtUSD(spent) : "spent"
                })
              })
            ]
          })
        : jsx("button", {
            className: "dsw-cw-rail",
            title: title,
            onClick: openModal,
            children: totals.length > 0 ? walletSymbol(totals[0].currency) : "$"
          });

      return jsxs(Fragment, {
        children: [
          wide ? jsx("div", { className: "dsw-cw-foot", children: trigger }) : jsx("div", { className: "dsw-cw-foot-rail", children: trigger }),
          jsx(Modal, {
            open,
            onClose: () => setOpen(false),
            title: "Spend",
            closeLabel: "Close",
            description: "Live DeepSeek Platform balances and top-up link, plus an estimated spend breakdown priced from provider-reported token usage.",
            contentClassName: "dsw-cw-scroll",
            children: jsx(Breakdown, { agg, cfg: c, onConfig: onPlatformConfig, saveError, summaryNote, platform })
          })
        ]
      });
    }

    // ------------------------------------------------------------------
    // Plugin face
    // ------------------------------------------------------------------

    const name = "dsh-cost-widget";

    /** Services this plugin needs at activation. */
    const inject = ["slots"];

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject("sidebar.footer.action", () =>
            ctx.slots.register(
              {
                name: "sidebar.footer.action",
                id: "cost-widget",
                order: 1,
                inject: () => ({})
              },
              CostFooter
            )
          ),
        "dsh-cost-widget: sidebar foot action"
      );
    }

    module.exports = { name, apply, inject };
    return module.exports;
  }
});
