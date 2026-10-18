import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Execute current entrypoints and their real ESM dependency graph. Only pg is replaced.
// Disposable inputs contain synthetic env/trace bytes only, never a source checkout.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hook = resolve(repository, "scripts/tests/fixtures/maintenance-hook.mjs");
const syntheticUrl = "postgresql://fixture.invalid/skipdb_maintenance";
function run(entrypoint, mode, readOnly, { omitUrl = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "skipdb-maintenance-inputs-"));
  try {
    const envPath = join(directory, "fixture.env");
    const tracePath = join(directory, "trace.jsonl");
    writeFileSync(envPath, [
      ...(omitUrl ? [] : ["DATABASE_URL=" + syntheticUrl]),
      "NEXT_PUBLIC_READ_ONLY=" + readOnly,
      "",
    ].join("\n"), { mode: 0o600 });
    const result = spawnSync(process.execPath, [
      "--import", hook, resolve(repository, entrypoint),
    ], {
      cwd: directory,
      // Do not inherit caller env, credentials, NODE_OPTIONS or dotenv options.
      env: {
        DOTENV_CONFIG_PATH: envPath,
        DOTENV_CONFIG_QUIET: "true",
        SKIPDB_MAINTENANCE_FIXTURE_MODE: mode,
        SKIPDB_MAINTENANCE_FIXTURE_TRACE: tracePath,
      },
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    const trace = (() => {
      try { return readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    })();
    return { ...result, trace };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function events(result, name) { return result.trace.filter((entry) => entry.event === name); }
function noSuccess(result) {
  assert.doesNotMatch(result.stdout, /Backfilled \d+ resolved groups/);
  assert.equal(events(result, "success-log").length, 0);
}
test("seed dotenv-only bootstrap reaches Pool interception before connections or seed work", () => {
  const result = run("src/db/seed.ts", "seed-bootstrap", "true");
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /maintenance-fixture-constructor-stop/);
  assert.doesNotMatch(result.stderr, /DATABASE_URL is not set/);
  assert.doesNotMatch(result.stdout, /Seeding SkipDB|Seed complete/);
  assert.deepEqual(result.trace, [{
    event: "pool",
    connectionString: syntheticUrl,
    readOnly: "true",
  }]);
});
test("seed missing-URL negative control fails before Pool construction", () => {
  const result = run("src/db/seed.ts", "seed-bootstrap", "false", { omitUrl: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DATABASE_URL is not set/);
  assert.deepEqual(result.trace, []);
});
test("db:resolve refuses dotenv-only READ_ONLY before the first query and exits nonzero", () => {
  const result = run("scripts/backfill-resolved.ts", "resolve", "true");
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /db:resolve refuses NEXT_PUBLIC_READ_ONLY=true/);
  assert.match(result.stderr, /NEXT_PUBLIC_READ_ONLY=false pnpm db:resolve/);
  assert.match(result.stderr, /scoped maintenance process/);
  assert.deepEqual(result.trace.map((entry) => entry.event), ["pool", "end"]);
  assert.equal(result.trace[0].readOnly, "true", "refusal must not override the flag");
  assert.deepEqual(result.trace[1].current, []);
  noSuccess(result);
});
test("writable db:resolve executes the actual resolver and commits work before success", () => {
  const result = run("scripts/backfill-resolved.ts", "resolve", "false");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /Backfilled 2 resolved groups without clearing legacy cache history\./);
  assert.equal(events(result, "pool").length, 1);
  assert.equal(events(result, "pool")[0].readOnly, "false");
  assert.equal(events(result, "connect").length, 2);
  assert.equal(events(result, "lock").length, 2);
  assert.equal(events(result, "upsert").length, 1);
  assert.equal(events(result, "delete-current").length, 1);
  assert.equal(events(result, "commit").length, 2);
  assert.equal(events(result, "rollback").length, 0);
  assert.equal(events(result, "release").length, 2);
  assert.equal(events(result, "success-log").length, 1);
  assert.ok(result.trace.findIndex((entry) => entry.event === "success-log") >
    result.trace.findLastIndex((entry) => entry.event === "commit"));
  const current = events(result, "end")[0].current;
  assert.equal(current.length, 1);
  assert.deepEqual(current[0].cacheKey, ["tt0000001", null, null, "intro"]);
  assert.equal(current[0].segmentId, 11, "actual resolver must select the higher-scored approved row");
  assert.equal(current[0].startMs, 12000);
  assert.ok(current[0].confidence > 0 && current[0].confidence <= 1);
});
test("a writable resolver cache-write failure rolls back and cannot print rebuild success", () => {
  const result = run("scripts/backfill-resolved.ts", "resolve-write-failure", "false");
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /maintenance-fixture-write-failure/);
  assert.equal(events(result, "lock").length, 1);
  assert.equal(events(result, "injected-write-failure").length, 1);
  assert.equal(events(result, "rollback").length, 1);
  assert.equal(events(result, "commit").length, 0);
  assert.equal(events(result, "release").length, 1);
  assert.deepEqual(events(result, "end")[0].current, []);
  noSuccess(result);
});
