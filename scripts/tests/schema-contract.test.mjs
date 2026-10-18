// Real installed Drizzle APIs, current schema/snapshot only; no DB/env/config evaluation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { test } from "node:test";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(root + "/src/db/schema.ts");
const ts = require("typescript");
const { generateDrizzleJson, generateMigration } = require("drizzle-kit/api");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const previous = JSON.parse(read("src/db/migrations/meta/0004_snapshot.json"));
const recorded = JSON.parse(read("src/db/migrations/meta/0005_snapshot.json"));
const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));
const schema = { exports: {} };
const compiled = ts.transpileModule(read("src/db/schema.ts"), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
new Function("require", "module", "exports", compiled)(require, schema, schema.exports);
const current = generateDrizzleJson(schema.exports, previous.id);
test("0005 snapshot chain matches journal and the actual current schema", async () => {
  assert.equal(recorded.prevId, previous.id);
  assert.notEqual(recorded.id, previous.id);
  assert.match(recorded.id, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
  assert.deepEqual(journal.entries.at(-1), { idx: 5, version: "7", when: 1792233000000,
    tag: "0005_resolved_current_cache", breakpoints: true });
  assert.deepEqual(await generateMigration(recorded, current), []);
  assert.deepEqual(await generateMigration(recorded, recorded), []);
});
test("0005 DDL is exactly the installed Drizzle diff; backfill remains additive", async () => {
  const ddl = await generateMigration(previous, recorded);
  assert.equal(ddl.length, 5);
  assert.ok(ddl.every((sql) => sql.includes('"resolved_segments_current"')));
  const sql = read("src/db/migrations/0005_resolved_current_cache.sql");
  const marker = sql.indexOf("-- Deterministic initialization only;");
  assert.ok(marker > 0);
  const clean = (text) => text.replace(/^--.*$/gm, "").replace(/\s+/g, " ").trim();
  assert.equal(clean(sql.slice(0, marker)), clean(ddl.join("\n")));
  assert.match(sql.slice(marker), /INSERT INTO "resolved_segments_current"/);
  assert.match(sql.slice(marker), /FROM "resolved_segments"/);
  assert.match(sql.slice(marker), /"updated_at" DESC, "id" DESC/);
  assert.ok(!/\b(?:DELETE|DROP|TRUNCATE|UPDATE)\s+"?resolved_segments"?\b/i.test(sql));
});
