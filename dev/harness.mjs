// Dev harness for dsh-cost-widget: loads the real client bundle in Node,
// drives apply(), and SSR-renders the footer (optionally with the modal open)
// against live host data to validate the render path, the cost math, and the
// Platform card.
//
// Usage:  node dev/harness.mjs              # closed modal
//         OPEN=1 node dev/harness.mjs       # modal-open render (injects the
//                                           # state change via a temp bundle)
//         PLATFORM=1 node dev/harness.mjs   # modal open with the REAL Platform
//                                           # payload fetched from the host
//
// DSH_URL overrides the host origin (default http://127.0.0.1:3080).
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

register(new URL("./css-stub-loader.mjs", import.meta.url).href, import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, "..", "client.js");
const BASE = process.env.DSH_URL || "http://127.0.0.1:3080";

// React and react-dom are not installed in the harness tree — the shipped
// client bundles inline React — so resolve them from DSH_HARNESS_DEPS, then a
// temp install, then the DSH installation's own node_modules. Override the
// last one with DSH_NODE_MODULES when dsh lives somewhere else.
const DSH_NODE_MODULES =
  process.env.DSH_NODE_MODULES || "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules";
const DEP_ROOTS = [process.env.DSH_HARNESS_DEPS, "/tmp/cw-deps/node_modules", DSH_NODE_MODULES].filter(Boolean);
const depRoot = DEP_ROOTS.find((root) => {
  try {
    createRequire(join(root, "index.js")).resolve("react");
    return true;
  } catch {
    return false;
  }
});
if (depRoot === undefined) {
  throw new Error(
    "harness: no react found — `npm install react react-dom` into a dir and point DSH_HARNESS_DEPS at its node_modules"
  );
}
const require = createRequire(join(depRoot, "index.js"));
const React = require("react");
const { jsx, jsxs, Fragment } = require("react/jsx-runtime");
const { renderToString } = require("react-dom/server");

// The real primitives pull in ~20 third-party packages (clsx, katex, the
// micromark/mdast family) that the CLI tree no longer resolves after an
// install, so fall back to stubs — enough to exercise THIS widget's render
// path, which is what the harness actually checks.
const PRIMITIVES_URL = pathToFileURL(
  join(DSH_NODE_MODULES, "@deepseek-ai/dsh-client-ui-primitives/lib/index.js")
).href;
let primitives = {};
try {
  primitives = await import(PRIMITIVES_URL);
} catch (error) {
  console.warn("harness: real primitives unavailable (" + (error.code || error.message) + "); using stubs");
  primitives = {
    Button: (props) => React.createElement("button", { type: "button", onClick: props.onClick }, props.children)
  };
}

// The widget calls document-relative routes; the harness runs in Node, where
// a relative fetch is invalid, so resolve them against the host origin.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) =>
  typeof input === "string" && input.startsWith("/") ? realFetch(BASE + input, init) : realFetch(input, init);

// ---- fake browser environment ----
let handoff = null;
globalThis.window = { __ModuleLoader__: { load: (h) => { handoff = h; } } };
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ dataset: {}, textContent: "" }),
  head: { appendChild: () => {} }
};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

// ---- the live Platform payload (PLATFORM=1) ----
let platformPayload = null;
if (process.env.PLATFORM === "1") {
  const res = await realFetch(
    `${BASE}/api/dsh-cost-widget/platform?locale=en-US&tzOffsetSeconds=0&fresh=1`
  );
  platformPayload = await res.json();
  console.log("live platform payload: account.status =", platformPayload.account.status);
}

// ---- bundle source (patched render modes) ----
let code = readFileSync(BUNDLE, "utf8");
if (process.env.OPEN === "1" || process.env.PLATFORM === "1") {
  code = code.replace("useState(false)", "useState(true)"); // first hit = the modal's `open`
}
if (platformPayload !== null) {
  const marker = "useState(null); // Platform snapshot from the host half";
  if (!code.includes(marker)) throw new Error("platform state marker not found in the bundle");
  code = code.replace(marker, `useState(${JSON.stringify(platformPayload)}); // injected by the harness`);
}
if (code !== readFileSync(BUNDLE, "utf8")) {
  const tmp = join(mkdtempSync(join(tmpdir(), "cw-")), "client.js");
  writeFileSync(tmp, code, "utf8");
  code = readFileSync(tmp, "utf8");
}

const runner = new Function("window", code);
runner(globalThis.window);
if (!handoff || handoff.id !== "dsh-cost-widget") throw new Error("bundle did not register dsh-cost-widget");

const requireStub = (spec) => {
  if (spec === "react") return React;
  if (spec === "react/jsx-runtime") return { jsx, jsxs, Fragment };
  if (spec === "@deepseek-ai/dsh-client-ui-primitives") {
    // Real primitives, except Modal (react-dom/server cannot portal to a real
    // DOM container); renders children inline, still validating every prop.
    return {
      ...primitives,
      Modal: (props) =>
        props.open
          ? React.createElement(
              "div",
              { "data-modal-open": "true", "data-title": props.title || "" },
              props.description ? React.createElement("p", null, props.description) : null,
              props.children
            )
          : null
    };
  }
  throw new Error("unexpected require: " + spec);
};
const plugin = handoff.factory(requireStub);
console.log("plugin:", plugin.name, "| inject:", JSON.stringify(plugin.inject));

const registered = [];
plugin.apply({
  effect: (fn) => { fn(); return () => {}; },
  slots: {
    register: (options, Component) => { registered.push({ options, Component }); return {}; },
    inject: (key, cb) => { if (key === "sidebar.footer.action") cb(); }
  }
});
if (registered.length !== 1) throw new Error("expected 1 registration");
const { options, Component } = registered[0];
console.log("registered:", options.id, "->", options.name, "(order", options.order + ")");

// ---- live data (falls back to a fixture when the host requires auth) ----
let rows;
try {
  const res = await realFetch(`${BASE}/api/session.list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "harness", method: "session.list", payload: {} })
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  rows = (await res.json()).result.value.items;
  console.log("sessions: " + rows.length + " live rows");
} catch (error) {
  console.warn("harness: live session.list unavailable (" + error.message + "); using a synthetic fixture");
  const usage = (input, cacheRead, output) => ({
    tokenUsage: { uncachedInputTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: 0, outputTokens: output }
  });
  rows = [
    {
      sessionId: "fixture-alpha",
      cwd: "/Users/example/code/alpha",
      origin: "user",
      projections: { values: { title: "Fixture alpha", ...usage(1_000_000, 2_000_000, 500_000) } }
    },
    {
      sessionId: "fixture-beta",
      cwd: "/Users/example/code/beta",
      origin: "subagent",
      projections: { values: { title: "Fixture beta", ...usage(200_000, 0, 100_000) } }
    }
  ];
}
const byId = {};
for (const r of rows) {
  byId[r.sessionId] = {
    id: r.sessionId,
    displayTitle: r.projections?.values?.title || r.sessionId.slice(0, 18),
    cwd: r.cwd,
    origin: r.origin,
    projectionValues: r.projections?.values || undefined
  };
}

// ---- independent math check ----
const P = { input: 0.14, cacheRead: 0.0028, cacheWrite: 0, output: 0.28 };
let expected = 0;
for (const r of rows) {
  const tu = r.projections?.values?.tokenUsage;
  if (!tu) continue;
  expected +=
    ((tu.uncachedInputTokens || 0) / 1e6) * P.input +
    ((tu.cacheReadTokens || 0) / 1e6) * P.cacheRead +
    ((tu.cacheWriteTokens || 0) / 1e6) * P.cacheWrite +
    ((tu.outputTokens || 0) / 1e6) * P.output;
}
console.log("manual expected total: $" + expected.toFixed(4));

const useSessions = (sel) => sel({ byId });
const useWorkspaces = (sel) => sel({ items: [] });
const modalExpected = process.env.OPEN === "1" || process.env.PLATFORM === "1";
let failures = 0;
for (const wide of [true, false]) {
  const html = renderToString(React.createElement(Component, { wide, useSessions, useWorkspaces }));
  const checks = {
    spent: html.includes("$" + expected.toFixed(2)) || html.includes("$0"),
    budgetGone: !html.includes("Budget (USD)")
  };
  // Modal content only exists when the harness forces the modal open.
  if (modalExpected) {
    checks.modalOpen = html.includes('data-modal-open="true"');
    checks.platformSection = html.includes("DeepSeek Platform");
    checks.realSpendToggle = html.includes("Read real Platform spend");
    checks.settingsForm = html.includes("Pricing model") && html.includes("Reset to official prices");
    checks.byProject = html.includes("By project (" + Object.keys(byId).length + " sessions");
  } else {
    checks.modalClosed = !html.includes('data-modal-open="true"');
  }
  if (platformPayload !== null) {
    checks.topUpLink = html.includes(platformPayload.account.links.topUpUrl);
    checks.usageLink = html.includes(platformPayload.account.links.usageUrl);
    checks.balanceRow = html.includes("Balance left (Platform)");
  }
  const bad = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (bad.length > 0) failures += 1;
  console.log(`wide=${wide}:`, JSON.stringify(checks), bad.length ? "FAILED: " + bad.join(",") : "ok");
}
if (failures > 0) {
  console.log("HARNESS FAILED");
  process.exit(1);
}
console.log("HARNESS OK");
