// Node ESM loader hook used by the dev harness:
//  - resolve .css imports to an empty module (the real dsh-client-ui-primitives
//    bundle imports them), and
//  - resolve the react family from wherever it actually exists, because the
//    shipped client bundles inline React and the CLI tree no longer carries a
//    resolvable copy for the primitives' own `import "react"` to find.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const DSH_NODE_MODULES =
  process.env.DSH_NODE_MODULES || "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules";
const DEP_ROOTS = [process.env.DSH_HARNESS_DEPS, "/tmp/cw-deps/node_modules", DSH_NODE_MODULES].filter(Boolean);
const REACT_FAMILY = /^react(-dom)?(\/.*)?$/;

/** First root that can resolve `specifier`, or null. */
function resolveFromRoots(specifier) {
  for (const root of DEP_ROOTS) {
    try {
      return createRequire(join(root, "index.js")).resolve(specifier);
    } catch {
      /* try the next root */
    }
  }
  return null;
}

export async function resolve(specifier, context, next) {
  if (specifier.endsWith(".css")) {
    return {
      url: "data:text/javascript," + encodeURIComponent("export default {}"),
      shortCircuit: true
    };
  }
  if (REACT_FAMILY.test(specifier)) {
    const hit = resolveFromRoots(specifier);
    if (hit !== null) return { url: pathToFileURL(hit).href, shortCircuit: true };
  }
  return next(specifier, context);
}
