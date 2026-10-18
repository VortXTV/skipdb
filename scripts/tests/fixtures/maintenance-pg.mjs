import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";

// This is a pg protocol-boundary SQL collaborator, not a PostgreSQL emulator.
// Actual connector/schema/Drizzle/resolver/entrypoints remain loaded.
const mode = process.env.SKIPDB_MAINTENANCE_FIXTURE_MODE;
const tracePath = process.env.SKIPDB_MAINTENANCE_FIXTURE_TRACE;
const syntheticUrl = "postgresql://fixture.invalid/skipdb_maintenance";
if (!["seed-bootstrap", "resolve", "resolve-write-failure"].includes(mode) || !tracePath) {
  throw new Error("Unsafe or incomplete maintenance fixture configuration");
}
function trace(event, detail = {}) {
  appendFileSync(tracePath, JSON.stringify({ event, ...detail }) + "\n", { mode: 0o600 });
}
const log = console.log.bind(console);
console.log = (...args) => {
  const message = args.join(" ");
  if (/^Backfilled \d+ resolved groups/.test(message)) trace("success-log", { message });
  log(...args);
};
const sourceRows = [
  row(10, "tt0000001", "approved", 1, 10000),
  row(11, "tt0000001", "approved", 3, 12000),
  row(12, "tt0000002", "pending", 0, 30000),
];
function row(id, imdbId, status, score, startMs) {
  return {
    id, title_id: id === 12 ? 2 : 1, imdb_id: imdbId, season: null, episode: null,
    segment_type: "intro", start_ms: String(startMs), end_ms: String(startMs + 10000),
    duration_ms: "60000", submitted_by: null, status, auto_approved: false,
    source: "web", votes_up: score, votes_down: 0, score, reviewed_by: null,
    reviewed_at: null, rejection_reason: null, created_at: "2026-10-18T00:00:00.000Z",
    updated_at: "2026-10-18T00:00:00.000Z",
  };
}
function arrayRows(text, rows) {
  const projection = text.slice("select ".length, text.indexOf(" from "));
  const columns = projection.split(",").map((field) => {
    const matches = [...field.matchAll(/"([^"]+)"/g)];
    assert.ok(matches.length, "Unexpected SELECT projection");
    return matches.at(-1)[1];
  });
  return rows.map((row) => columns.map((column) => row[column] ?? null));
}
export class Pool {
  constructor(options) {
    trace("pool", { connectionString: options.connectionString, readOnly: process.env.NEXT_PUBLIC_READ_ONLY });
    assert.equal(options.connectionString, syntheticUrl);
    assert.ok(["true", "false"].includes(process.env.NEXT_PUBLIC_READ_ONLY));
    if (mode === "seed-bootstrap") throw new Error("maintenance-fixture-constructor-stop");
    this.current = new Map();
  }
  async connect() {
    assert.equal(process.env.NEXT_PUBLIC_READ_ONLY, "false", "read-only command attempted a connection");
    trace("connect");
    return { query: this.query.bind(this), release() { trace("release"); } };
  }
  async query(config, values = []) {
    assert.equal(process.env.NEXT_PUBLIC_READ_ONLY, "false", "read-only command attempted a query");
    const text = typeof config === "string" ? config : config.text;
    trace("query", { text, values });
    if (/^(begin|commit|rollback)$/i.test(text)) {
      trace(text.toLowerCase());
      return { rows: [] };
    }
    if (text.includes("pg_advisory_xact_lock")) {
      assert.equal(values.length, 1);
      trace("lock", { cacheKey: JSON.parse(values[0]) });
      return { rows: [] };
    }
    if (text.startsWith("select ") && text.includes(' from "segments"')) {
      assert.equal(config.rowMode, "array");
      let rows = sourceRows;
      if (text.includes(" where ")) {
        assert.equal(values.length, 3);
        assert.equal(values[2], "approved");
        assert.match(text, /"season" is null/);
        assert.match(text, /"episode" is null/);
        rows = rows.filter((row) => row.imdb_id === values[0] &&
          row.segment_type === values[1] && row.status === values[2]);
        rows = [...rows].sort((a, b) => b.score - a.score || b.votes_up - a.votes_up || b.id - a.id);
      }
      return { rows: arrayRows(text, rows) };
    }
    if (text.startsWith('insert into "resolved_segments_current"')) {
      assert.match(text, /on conflict \("cache_key"\) do update/);
      if (mode === "resolve-write-failure") {
        trace("injected-write-failure");
        throw new Error("maintenance-fixture-write-failure");
      }
      const insert = text.match(/insert into "resolved_segments_current" \(([^)]+)\) values \(([^)]+)\)/);
      assert.ok(insert, "Unexpected current-cache INSERT");
      const columns = insert[1].split(",").map((column) => column.trim().slice(1, -1));
      const expressions = insert[2].split(",").map((expression) => expression.trim());
      assert.equal(columns.length, expressions.length);
      const inserted = Object.fromEntries(columns.map((column, index) => {
        const expression = expressions[index];
        assert.match(expression, /^(default|\$\d+)$/);
        return [column, expression === "default" ? null : values[Number(expression.slice(1)) - 1]];
      }));
      const value = {
        cacheKey: JSON.parse(inserted.cache_key), segmentId: inserted.segment_id,
        startMs: Number(inserted.start_ms), confidence: inserted.confidence,
      };
      this.current.set(JSON.stringify(value.cacheKey), value);
      trace("upsert", value);
      return { rows: [] };
    }
    if (text.startsWith('delete from "resolved_segments_current"')) {
      assert.equal(values.length, 1);
      const cacheKey = JSON.parse(values[0]);
      this.current.delete(JSON.stringify(cacheKey));
      trace("delete-current", { cacheKey });
      return { rows: [] };
    }
    throw new Error("Unexpected SQL in maintenance fixture: " + text);
  }
  async end() { trace("end", { current: [...this.current.values()] }); }
}
export const types = {
  builtins: { TIMESTAMPTZ: 1184, TIMESTAMP: 1114, DATE: 1082, INTERVAL: 1186 },
  getTypeParser() { return (value) => value; },
};
export default { Pool, types };
