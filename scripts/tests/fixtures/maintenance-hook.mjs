import { existsSync, readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const rootUrl = pathToFileURL(repository + "/").href;
const fixturePg = new URL("./maintenance-pg.mjs", import.meta.url).href;
if (!process.env.SKIPDB_MAINTENANCE_FIXTURE_MODE ||
    !process.env.SKIPDB_MAINTENANCE_FIXTURE_TRACE ||
    !process.env.DOTENV_CONFIG_PATH) {
  throw new Error("Maintenance fixture requires its own explicit mode, trace and dotenv path");
}
globalThis.fetch = async () => { throw new Error("Maintenance fixture forbids network access"); };
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "pg") return { url: fixturePg, shortCircuit: true };
    let candidate;
    if (specifier.startsWith("@/")) candidate = resolve(repository, "src", specifier.slice(2));
    else if (specifier.startsWith(".") && context.parentURL?.startsWith(rootUrl) &&
        !context.parentURL.includes("/node_modules/")) {
      candidate = resolve(dirname(fileURLToPath(context.parentURL)), specifier);
    }
    if (candidate && !extname(candidate)) {
      for (const file of [candidate + ".ts", resolve(candidate, "index.ts")]) {
        if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(rootUrl) && !url.includes("/node_modules/") && url.endsWith(".ts")) {
      // Keep every runtime import and its ESM evaluation order; erase types only.
      return {
        format: "module",
        source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8")),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
