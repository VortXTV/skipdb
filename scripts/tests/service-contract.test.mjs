import assert from "node:assert/strict";
import { stripTypeScriptTypes } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Current owning-repository handlers and helpers; dependency-injected query collaborators.
// The SQLite collaborator validates local transaction rollback/unique rows, NOT PostgreSQL
// JSONB, advisory locks, migration DDL, or production isolation. No network or credentials.
globalThis.fetch = async () => { throw new Error("Live network disabled"); };
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const revision = "current-source";
const raw = (file) => readFileSync(resolve(repository, file), "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const tableNames = ["segments", "votes", "users", "moderationLog", "titles", "episodes", "apiKeys", "resolvedSegments", "legacyResolvedSegments"];
const tables = Object.fromEntries(tableNames.map((name) => [name, new Proxy({ name }, { get(target, column) {
  return column === "name" ? target.name : { table: target.name, column };
} })]));
const eq = (column, value) => ({ op: "eq", column, value });
const isNull = (column) => eq(column, null);
const and = (...values) => ({ op: "and", values });
const ne = (column, value) => ({ op: "ne", column, value });
const gt = (column, value) => ({ op: "gt", column, value });
const desc = (column) => ({ column, descending: true });
const sql = (strings, ...values) => ({ sql: true, text: strings.join("?"), values });
const z = new Proxy(function () {}, { apply() { return z; }, get(_target, key) {
  if (key === "safeParse") return (data) => ({ success: true, data });
  return z;
} });
const json = (value, init) => Response.json(value, init);
const apiError = (message, status = 400) => Response.json({ error: message }, { status });
const readOnlyError = () => apiError("This instance is read-only.", 405);
const fixtureSegment = (extra = {}) => ({
  id: 1, titleId: 1, imdbId: "tt0000001", season: null, episode: null, segmentType: "intro",
  startMs: 10000, endMs: 20000, durationMs: 60000, submittedBy: "contributor", status: "pending",
  autoApproved: false, votesUp: 0, votesDown: 0, score: 0,
  createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z", ...extra,
});
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function matches(row, predicate) {
  if (!predicate) return true;
  if (predicate.op === "and") return predicate.values.every((item) => matches(row, item));
  const value = row[predicate.column.column];
  if (predicate.op === "eq") return same(value ?? null, predicate.value ?? null);
  if (predicate.op === "ne") return !same(value, predicate.value);
  if (predicate.op === "gt") return new Date(value).getTime() > new Date(predicate.value).getTime();
  throw new Error("Unexpected predicate");
}
function memoryDb({ uniqueResolved = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of tableNames) {
    const extra = name === "resolvedSegments" ? ", cache_key TEXT" + (uniqueResolved ? " UNIQUE" : "")
      : name === "votes" ? ", segment_id INTEGER, user_id TEXT, UNIQUE(segment_id, user_id)" : "";
    sqlite.exec('CREATE TABLE "' + name + '" (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL' + extra + ")");
  }
  const trace = [];
  let tail = Promise.resolve();
  const db = { trace, failTable: null, failOperation: null, transactionDepth: 0,
    rows(table) { return sqlite.prepare('SELECT data FROM "' + table + '" ORDER BY id').all().map((row) => JSON.parse(row.data)); },
    snapshot() { return JSON.stringify(Object.fromEntries(tableNames.map((name) => [name, db.rows(name)]))); },
    seed(name, values) { for (const value of values) insertRow(name, value, false); },
    async transaction(callback) {
      const prior = tail; let release; tail = new Promise((done) => { release = done; }); await prior;
      sqlite.exec("BEGIN"); db.transactionDepth++; trace.push({ operation: "begin" });
      try { const result = await callback(db); sqlite.exec("COMMIT"); trace.push({ operation: "commit" }); return result; }
      catch (error) { sqlite.exec("ROLLBACK"); trace.push({ operation: "rollback" }); throw error; }
      finally { db.transactionDepth--; release(); }
    },
    async execute(statement) {
      assert.ok(db.transactionDepth > 0);
      assert.match(statement.text, /pg_advisory_xact_lock.*hashtextextended/);
      trace.push({ operation: "advisory-lock", key: statement.values[0] });
    },
    select(projection) { return query("select", null, projection); },
    insert(table) { return query("insert", table.name); },
    update(table) { return query("update", table.name); },
    delete(table) { return query("delete", table.name); },
    close() { sqlite.close(); },
  };
  function fail(operation, name) {
    if (db.failTable === name && (!db.failOperation || db.failOperation === operation)) throw new Error("injected-" + name);
  }
  function writeData(name, id, value) {
    sqlite.prepare('UPDATE "' + name + '" SET data = ? WHERE id = ?').run(JSON.stringify(value), id);
  }
  function insertRow(name, value, upsert) {
    value = name === "segments" ? fixtureSegment({ id: undefined, ...value }) : { ...value };
    const columns = ["data"], args = [JSON.stringify(value)];
    if (value.id != null && typeof value.id === "number") { columns.push("id"); args.push(value.id); }
    if (name === "votes") { columns.push("segment_id", "user_id"); args.push(value.segmentId, value.userId); }
    if (name === "resolvedSegments") { columns.push("cache_key"); args.push(value.cacheKey ? JSON.stringify(value.cacheKey) : null); }
    let statement = 'INSERT INTO "' + name + '" (' + columns.join(",") + ") VALUES (" + columns.map(() => "?").join(",") + ")";
    if (upsert) statement += name === "votes" ? " ON CONFLICT(segment_id,user_id) DO UPDATE SET data=excluded.data" : " ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data";
    const rowId = sqlite.prepare(statement + " RETURNING id").get(...args).id;
    value.id ??= rowId; writeData(name, rowId, value); return value;
  }
  function query(operation, name, projection) {
    let predicate, limit, ordering = [], values, conflict = false, executed;
    const chain = {
      from(table) { name = table.name; return chain; },
      where(value) { predicate = value; return chain; },
      orderBy(...columns) { ordering = columns; return chain; },
      limit(value) { limit = value; return chain; },
      for(mode) { assert.equal(mode, "update"); trace.push({ operation: "row-lock", table: name }); return chain; },
      values(value) { values = value; return chain; },
      set(value) { values = value; return chain; },
      onConflictDoUpdate() { conflict = true; return chain; },
      onConflictDoNothing() { return chain; },
      innerJoin() { return chain; },
      returning() { return chain; },
      then(resolve, reject) { executed ??= run(); return executed.then(resolve, reject); },
      catch(reject) { return chain.then((value) => value).catch(reject); },
    };
    async function run() {
      trace.push({ operation, table: name, transactional: !!db.transactionDepth }); fail(operation, name);
      if (operation === "insert") return (Array.isArray(values) ? values : [values]).map((value) => insertRow(name, value, conflict));
      let rows = db.rows(name).filter((row) => matches(row, predicate));
      if (operation === "delete") { for (const row of rows) sqlite.prepare('DELETE FROM "' + name + '" WHERE json_extract(data, \'$.id\') = ?').run(row.id); return []; }
      if (operation === "update") return rows.map((row) => {
        const next = { ...row };
        for (const [key, value] of Object.entries(values)) {
          if (value?.sql) next[key] = row[key] + Number(value.values.at(-1));
          else next[key] = value;
        }
        sqlite.prepare('UPDATE "' + name + '" SET data = ? WHERE json_extract(data, \'$.id\') = ?').run(JSON.stringify(next), row.id); return next;
      });
      if (ordering.length) rows.sort((a, b) => {
        for (const item of ordering) { const key = item.column.column; if (a[key] !== b[key]) return (a[key] > b[key] ? -1 : 1) * (item.descending ? 1 : -1); }
        return 0;
      });
      if (limit !== undefined) rows = rows.slice(0, limit);
      if (projection?.up && projection?.down) return [{
        up: rows.filter((row) => row.value === 1).length, down: rows.filter((row) => row.value === -1).length,
      }];
      if (projection?.total) return [{ total: rows.reduce((sum, row) => sum + row.score, 0) }];
      if (projection) return rows.map((row) => Object.fromEntries(Object.entries(projection).map(([key, column]) => [key, row[column.column]])));
      return rows;
    }
    return chain;
  }
  return db;
}
const config = (await new AsyncFunction(stripTypeScriptTypes(raw("src/lib/config.ts")).replace(/^export /gm, "") + "\nreturn config;")());
async function load(file, names, db, overrides = {}, green = true) {
  const defaults = { ...tables, db, eq, ne, gt, and, isNull, desc, sql, z, config, json, apiError, readOnlyError,
    READ_ONLY: false, preflight: () => null, rateLimit: () => ({ ok: true }), rateLimitHeaders: () => ({}),
    clientIp: () => "fixture", requireStaff: async () => ({ id: "staff", role: "admin" }),
    getActor: async () => ({ user: { id: "voter", role: "user", reputation: 100 }, via: "session" }),
    auth: async () => ({ user: { id: "user" } }), usesSocialLogin: async () => false, hasMxRecord: async () => true,
    voteSchema: { safeParse: (data) => ({ success: true, data }) },
    editSchema: { safeParse: (data) => ({ success: true, data }) },
    submitSchema: { safeParse: (data) => ({ success: true, data }) },
    profileSchema: { safeParse: (data) => ({ success: true, data }) },
    validateSegmentBounds: () => null, reviewSubmission: async () => ({ status: "pending", autoApproved: false, reasons: ["fixture"] }),
    recomputeResolved: async () => {}, parseTimeToMs: (value) => value == null ? null : Number(value) * 1000,
    roundTime: (value) => Math.round(value), LICENSE_NOTICE: "fixture", ...overrides };
  const source = stripTypeScriptTypes(raw(file, green)).replace(/^import[\s\S]*?;\s*/gm, "").replace(/^export /gm, "");
  const namesList = Object.keys(defaults);
  return new AsyncFunction(...namesList, source + "\nreturn {" + names.join(",") + "};")(...namesList.map((name) => defaults[name]));
}
async function context(db, green = true, overrides = {}) {
  const rep = green ? await load("src/lib/reputation.ts", ["applyReputationChange", "segmentReputation"], db, overrides) : {};
  return { ...overrides, ...rep };
}
const request = (body) => new Request("https://fixture.invalid/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const params = { params: Promise.resolve({ id: "1" }) };
const receipts = [];
for (const green of [true]) {
  const db = memoryDb(); db.seed("segments", [fixtureSegment()]); db.seed("users", [{ id: "contributor", reputation: 100 }]);
  const deps = await context(db, green);
  const admin = await load("src/app/api/admin/segments/[id]/route.ts", ["POST"], db, deps, green);
  await admin.POST(request({ action: "approve" }), params); await admin.POST(request({ action: "approve" }), params);
  const repeatedApproval = db.rows("users")[0].reputation;
  assert.equal(repeatedApproval, 105);
  const vote = await load("src/app/api/segments/[id]/vote/route.ts", ["POST"], db, deps, green);
  await vote.POST(request({ value: 1 }), params);
  const afterVote = db.rows("users")[0].reputation;
  assert.equal(afterVote, 106);
  receipts.push({ case: "actual_moderation_replay_and_vote", version: "current-source", repeatedApproval, afterVote });
  if (green) {
    await admin.POST(request({ action: "reject" }), params); assert.equal(db.rows("users")[0].reputation, 101);
    await admin.POST(request({ action: "reject" }), params); assert.equal(db.rows("users")[0].reputation, 101);
    await vote.POST(request({ value: -1 }), params); assert.equal(db.rows("users")[0].reputation, 99);
    await vote.POST(request({ value: 0 }), params); assert.equal(db.rows("users")[0].reputation, 100);
    await admin.POST(request({ action: "approve" }), params); assert.equal(db.rows("users")[0].reputation, 105);
    receipts.push({ case: "reversal_vote_change_withdrawal_reapproval", reputation: 105, legacyBaselineRetained: 100 });
    assert.ok(db.trace.some((item) => item.operation === "row-lock"));
  }
  db.close();
}
{
  const db = memoryDb(); db.seed("users", [{ id: "contributor", reputation: 100 }]);
  let recomputes = 0;
  const deps = await context(db, true, {
    getActor: async () => ({ user: { id: "contributor", role: "user", reputation: 100 }, via: "api-key" }),
    ensureTitle: async () => ({ id: 1 }), recomputeResolved: async () => { recomputes++; },
    reviewSubmission: async () => ({ status: "approved", autoApproved: true, reasons: ["fixture"] }),
  });
  const create = await load("src/app/api/segments/route.ts", ["POST"], db, deps);
  const input = { imdbId: "tt0000001", season: null, episode: null, segmentType: "intro", startMs: 10000, endMs: 20000, durationMs: 60000 };
  assert.equal((await create.POST(request(input))).status, 201);
  assert.equal(db.rows("users")[0].reputation, 105);
  assert.equal(db.rows("moderationLog").length, 1);
  assert.equal(recomputes, 1);
  // Actual recent-own resubmit path, returning an approval to pending.
  const resubmit = await load("src/app/api/segments/route.ts", ["POST"], db, {
    ...deps, reviewSubmission: async () => ({ status: "pending", autoApproved: false, reasons: ["review"] }),
  });
  await db.update(tables.segments).set({ createdAt: new Date() }).where(eq(tables.segments.id, 1));
  assert.equal((await resubmit.POST(request({ ...input, startMs: 12000 }))).status, 200);
  assert.equal(db.rows("segments")[0].status, "pending");
  assert.equal(db.rows("users")[0].reputation, 100);
  assert.equal(recomputes, 2, "losing prior approval must also refresh cache");
  const staff = await load("src/lib/staff-submit.ts", ["insertStaffSegment"], db, deps);
  const created = await staff.insertStaffSegment({ titleId: 1, imdbId: "tt0000001", season: 1, episode: 1,
    segmentType: "intro", startMs: 10000, endMs: 20000, durationMs: 60000, submittedById: "contributor" });
  assert.equal(created.kind, "created"); assert.equal(db.rows("users")[0].reputation, 105);
  const snapshot = db.snapshot(); db.failTable = "moderationLog";
  await assert.rejects(staff.insertStaffSegment({ titleId: 1, imdbId: "tt0000001", season: 1, episode: 2,
    segmentType: "intro", startMs: 10000, endMs: 20000, durationMs: 60000, submittedById: "contributor" }), /injected/);
  assert.equal(db.snapshot(), snapshot);
  receipts.push({ case: "actual_creation_resubmit_staff_paths", approvalCredit: 5, resubmitReversal: -5, resubmitCacheRefresh: true, staffFailureRollback: "exact" });
  db.close();
}
{
  const db = memoryDb(); let calls = 0;
  const effects = { adapter: 0, smtp: 0, provider: 0 }; let configured;
  const adapter = { updateSession: async () => { effects.adapter++; }, deleteSession: async () => { effects.adapter++; } };
  const runtime = { handlers: { GET() {}, POST() {} }, auth: async () => {
    calls++; await adapter.updateSession(); return { user: { id: "fixture" } };
  }, signIn: async () => {
    calls++; effects.provider++;
    await configured.providers[0].sendVerificationRequest({ identifier: "fixture@example.invalid", url: "https://fixture.invalid/callback" });
    await configured.events.signIn({ user: { id: "fixture", email: "fixture@example.invalid" } });
  }, signOut: async () => { calls++; await adapter.deleteSession(); } };
  const deps = { READ_ONLY: true, process: { env: { EMAIL_SERVER: "smtp://fixture.invalid:587", EMAIL_FROM: "fixture@example.invalid" } },
    NextAuth: (options) => { configured = options; return runtime; }, DrizzleAdapter: () => adapter,
    Nodemailer: (options) => options, nodemailer: { createTransport: () => ({ sendMail: async () => { effects.smtp++; } }) },
    isAdminEmail: () => true, accounts: {}, sessions: {}, verificationTokens: {} };
  const auth = await load("src/lib/auth.ts", ["auth", "signIn", "signOut"], db, deps);
  assert.equal(await auth.auth(), null);
  assert.throws(() => auth.signIn("github"), /read-only/);
  assert.throws(() => auth.signOut(), /read-only/);
  assert.equal(calls, 0); assert.equal(db.trace.length, 0);
  assert.deepEqual(effects, { adapter: 0, smtp: 0, provider: 0 });
  receipts.push({ case: "actual_server_auth_and_server_actions_read_only", underlyingCalls: 0, databaseQueries: 0, effects });
  db.close();
}
{
  const db = memoryDb(); let effects = 0;
  const forbidden = () => { effects++; throw new Error("unexpected key/session effect"); };
  const keys = await load("src/lib/api-key.ts", ["generateApiKey", "revokeApiKeys"], db,
    { READ_ONLY: true, randomBytes: forbidden, createHash: forbidden, encryptSecret: forbidden });
  await assert.rejects(keys.generateApiKey("fixture"), /read-only/);
  await assert.rejects(keys.revokeApiKeys("fixture"), /read-only/);
  const sessions = await load("src/lib/session.ts", ["createUserSession"], db,
    { READ_ONLY: true, sessions: {}, randomUUID: forbidden, cookies: forbidden });
  await assert.rejects(sessions.createUserSession("fixture"), /read-only/);
  assert.equal(effects, 0); assert.equal(db.trace.length, 0);
  receipts.push({ case: "actual_read_only_key_and_session_helpers", cryptoCookieDatabaseEffects: 0 });
  db.close();
}
{
  const db = memoryDb(); db.seed("segments", [fixtureSegment()]); db.seed("users", [{ id: "contributor", reputation: 100 }]);
  const deps = await context(db), admin = await load("src/app/api/admin/segments/[id]/route.ts", ["POST"], db, deps);
  await Promise.all([admin.POST(request({ action: "approve" }), params), admin.POST(request({ action: "approve" }), params)]);
  assert.equal(db.rows("users")[0].reputation, 105);
  const votes = await Promise.all(["voter-a", "voter-b"].map(async (id) => load("src/app/api/segments/[id]/vote/route.ts", ["POST"], db,
    { ...deps, getActor: async () => ({ user: { id, role: "user", reputation: 0 } }) })));
  await Promise.all(votes.map((route) => route.POST(request({ value: 1 }), params)));
  assert.equal(db.rows("segments")[0].votesUp, 2); assert.equal(db.rows("users")[0].reputation, 107);
  const snapshot = db.snapshot(); db.failTable = "moderationLog";
  await assert.rejects(admin.POST(request({ action: "reject" }), params), /injected/);
  assert.equal(db.snapshot(), snapshot); assert.ok(db.trace.some((item) => item.operation === "rollback"));
  receipts.push({ case: "actual_transaction_concurrency_and_audit_failure", concurrentApprovalCredit: 5, concurrentVotes: 2, finalReputation: 107, rollback: "exact" });
  db.close();
}
{
  const db = memoryDb(); db.seed("segments", [fixtureSegment()]); db.seed("users", [{ id: "contributor", reputation: 100 }]);
  let attempts = 0;
  const deps = await context(db, true, { recomputeResolved: async () => { if (++attempts === 1) throw new Error("cache-write-fault"); } });
  const route = await load("src/app/api/admin/segments/[id]/route.ts", ["POST"], db, deps);
  await assert.rejects(route.POST(request({ action: "approve" }), params), /cache-write-fault/);
  assert.equal(db.rows("segments")[0].status, "approved"); assert.equal(db.rows("users")[0].reputation, 105);
  assert.equal((await route.POST(request({ action: "approve" }), params)).status, 200);
  assert.equal(db.rows("users")[0].reputation, 105); assert.equal(attempts, 2);
  receipts.push({ case: "actual_postcommit_cache_failure_retry", committedApprovalRetained: true, retryAddedReputation: 0 });
  db.close();
}
{
  const db = memoryDb(); db.seed("segments", [fixtureSegment({ status: "approved" })]); db.seed("users", [{ id: "contributor", reputation: 105 }]);
  const deps = await context(db), edit = await load("src/app/api/segments/[id]/route.ts", ["PATCH", "DELETE"], db,
    { ...deps, getActor: async () => ({ user: { id: "contributor", role: "user", reputation: 105 } }) });
  const response = await edit.PATCH(request({ start_ms: 11000 }), params); assert.equal(response.status, 200);
  assert.equal(db.rows("segments")[0].status, "pending"); assert.equal(db.rows("users")[0].reputation, 100);
  db.seed("segments", [fixtureSegment({ id: 2, status: "approved", score: 2 })]); db.rows("users");
  await db.update(tables.users).set({ reputation: 107 }).where(eq(tables.users.id, "contributor"));
  const deleted = await edit.DELETE(request({}), { params: Promise.resolve({ id: "2" }) }); assert.equal(deleted.status, 200);
  assert.equal(db.rows("users")[0].reputation, 100);
  receipts.push({ case: "actual_edit_to_pending_and_delete_reverse_contribution", finalReputation: 100 });
  db.close();
}
{
  let touched = 0; const forbidden = async () => { touched++; throw new Error("Unexpected collaborator call"); };
  const overrides = { READ_ONLY: true, auth: forbidden, requireStaff: forbidden, getActor: forbidden,
    handlers: { GET: forbidden, POST: forbidden }, generateApiKey: forbidden, revokeApiKeys: forbidden, activeKeyInfo: forbidden,
    ensureTitle: forbidden, recomputeResolved: forbidden, insertStaffSegment: forbidden };
  const blocked = [
    ["src/app/api/profile/route.ts", "POST"], ["src/app/api/keys/route.ts", "DELETE"],
    ["src/app/api/admin/import/route.ts", "POST"], ["src/app/api/admin/bulk/route.ts", "POST"],
    ["src/app/api/admin/segments/[id]/route.ts", "POST"], ["src/app/api/auth/[...nextauth]/route.ts", "GET"],
    ["src/app/api/auth/[...nextauth]/route.ts", "POST"],
  ];
  const db = memoryDb();
  for (const [file, method] of blocked) {
    const route = await load(file, [method], db, overrides); const result = await route[method](request({}), params); assert.equal(result.status, 405, file);
  }
  assert.equal(touched, 0); assert.equal(db.trace.length, 0);
  receipts.push({ case: "actual_read_only_routes", blockedHandlers: blocked.length, collaboratorCalls: touched, databaseQueries: db.trace.length });
  db.close();
}
{
  const db = memoryDb(); db.seed("titles", [{ id: 1, imdbId: "tt0000001", mediaType: "series", name: "Cached", tmdbId: 7, posterUrl: null }]);
  let network = 0;
  const title = await load("src/lib/titles.ts", ["ensureTitle", "ensureSeasonEpisodes", "ReadOnlyTitleMissingError"], db, {
    READ_ONLY: true, tmdbEnabled: () => true, findByImdb: async () => { network++; throw new Error("metadata write path"); },
    getSeasonEpisodes: async () => { network++; throw new Error("episode fill"); },
  });
  assert.equal((await title.ensureTitle("tt0000001")).name, "Cached");
  await assert.rejects(title.ensureTitle("tt0000002"), title.ReadOnlyTitleMissingError);
  await title.ensureSeasonEpisodes({ id: 1, tmdbId: 7, mediaType: "series" }, 1);
  assert.equal(network, 0); assert.ok(db.trace.every((item) => item.operation === "select"));
  const api = await load("src/app/api/titles/[imdbId]/route.ts", ["GET"], db, {
    ReadOnlyTitleMissingError: title.ReadOnlyTitleMissingError,
    getTitleOverview: async () => { throw new title.ReadOnlyTitleMissingError(); },
  });
  assert.equal((await api.GET(new Request("https://fixture.invalid/api"), { params: Promise.resolve({ imdbId: "tt0000002" }) })).status, 404);
  receipts.push({ case: "actual_read_only_metadata", cachedTitle: "readable", missingTitle: 404, metadataNetworkCalls: 0, databaseWrites: 0 });
  db.close();
}
{
  const confidence = await load("src/lib/confidence.ts", ["computeConfidence", "countAgreement"], memoryDb());
  const key = { imdbId: "tt0000001", titleId: 1, season: null, episode: null, segmentType: "intro" };
  for (const green of [true]) {
    const db = memoryDb({ uniqueResolved: green }); db.seed("segments", [fixtureSegment({ status: "approved" })]);
    const resolver = await load("src/lib/resolved.ts", ["recomputeResolved", "getResolved"], db, confidence, green);
    await Promise.all([resolver.recomputeResolved(key), resolver.recomputeResolved(key)]);
    const count = db.rows("resolvedSegments").length; assert.equal(count, 1);
    if (green) {
      const legacy = [{ id: 1, imdbId: "tt0000001", season: null, episode: null, updatedAt: "2026-10-17", payload: "legacy-A" }, { id: 2, imdbId: "tt0000001", season: null, episode: null, updatedAt: "2026-10-17", payload: "legacy-B" }];
      db.seed("legacyResolvedSegments", legacy);
      const legacyBytes = JSON.stringify(db.rows("legacyResolvedSegments")), legacyHash = createHash("sha256").update(legacyBytes).digest("hex");
      db.seed("segments", [fixtureSegment({ id: 2, season: 0, episode: 0, status: "approved", score: 2 })]);
      await resolver.recomputeResolved({ ...key, season: 0, episode: 0 }); assert.equal(db.rows("resolvedSegments").length, 2);
      assert.equal((await resolver.getResolved({ imdbId: key.imdbId, season: null, episode: null })).length, 1);
      const before = db.snapshot(); db.failTable = "resolvedSegments"; db.failOperation = "insert";
      await assert.rejects(resolver.recomputeResolved(key), /injected/); assert.equal(db.snapshot(), before);
      assert.equal(createHash("sha256").update(JSON.stringify(db.rows("legacyResolvedSegments"))).digest("hex"), legacyHash);
      const locks = db.trace.filter((item) => item.operation === "advisory-lock"); assert.ok(locks.length >= 4);
      const readOnly = await load("src/lib/resolved.ts", ["recomputeResolved"], db, { ...confidence, READ_ONLY: true });
      const traceLength = db.trace.length; await readOnly.recomputeResolved(key); assert.equal(db.trace.length, traceLength);
      receipts.push({ case: "cache_unique_null_zero_and_failure", cacheRows: 2, existingRowSurvivesFailedUpsert: true, advisoryLockCalls: locks.length, readOnlyQueries: 0, legacyFixtureHash: legacyHash });
    }
    receipts.push({ case: "actual_resolver_concurrency", version: "current-source", rowsForOneKey: count });
    db.close();
  }
}
const migration = raw("src/db/migrations/0005_resolved_current_cache.sql");
assert.ok(!/\b(?:DELETE|DROP|TRUNCATE|UPDATE)\s+(?:"?resolved_segments"?\b)/i.test(migration));
assert.match(migration, /jsonb_build_array/); assert.match(migration, /CREATE UNIQUE INDEX/);
assert.match(migration, /"updated_at" DESC, "id" DESC/);
console.log(JSON.stringify({ revision, result: "passed", actualSourceCases: receipts, limits: [
  "SQLite dependency collaborator is not PostgreSQL advisory-lock, JSONB, migration, or isolation proof",
  "PostgreSQL server/runtime and installed project dependency typecheck remain operational gates",
  "Forwarded-IP proxy policy remains unverified; no trusted-header configuration inferred",
] }, null, 2));
