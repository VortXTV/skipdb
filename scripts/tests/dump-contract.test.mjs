import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Executes actual exporter/API/importer source with an in-memory query collaborator.
// No database, credentials, network or dependency installation is required.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const tables = Object.fromEntries(['segments', 'titles', 'users'].map(table => [table, new Proxy({}, {
  get: (_target, column) => ({ table, column }),
})]));
const fixture = [
  { title: { name: 'Fixture movie', mediaType: 'movie' }, segment: { id: 1, imdbId: 'tt0000001', season: null, episode: null, segmentType: 'intro', status: 'approved', submittedBy: 'fixture-user', startMs: 1000, endMs: 5000, durationMs: 60000, votesUp: 3, votesDown: 1, score: 2, createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z' } },
  { title: { name: 'Fixture series', mediaType: 'series' }, segment: { id: 2, imdbId: 'tt0000002', season: 1, episode: 2, segmentType: 'outro', status: 'pending', submittedBy: null, startMs: 50000, endMs: 59000, durationMs: 60000, votesUp: 0, votesDown: 0, score: 0, createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z' } },
  { title: { name: 'Fixture series', mediaType: 'series' }, segment: { id: 3, imdbId: 'tt0000002', season: 1, episode: 3, segmentType: 'intro', status: 'rejected', submittedBy: null, startMs: 1000, endMs: 5000, durationMs: 60000, votesUp: 0, votesDown: 1, score: -1, createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z' } },
];
function source(file) {
  const value = readFileSync(resolve(root, file), 'utf8');
  return stripTypeScriptTypes(value).replace(/^import[\s\S]*?;\s*/gm, '').replace(/^export /gm, '');
}
function memoryDb() {
  const imported = { titles: [], segments: [], users: [] };
  return { imported, select(projection) {
    let predicate;
    const query = { from() { return query; }, leftJoin() { return query; }, where(value) { predicate = value; return query; }, then(resolveRows, rejectRows) {
      const rows = fixture.filter(row => !predicate || row.segment[predicate.column.column] === predicate.value)
        .map(row => Object.fromEntries(Object.entries(projection).map(([key, column]) => [key, (column.table === 'titles' ? row.title : row.segment)[column.column]])));
      return Promise.resolve(rows).then(resolveRows, rejectRows);
    } };
    return query;
  }, insert(table) { return { values(value) {
    if (table === tables.titles) return { onConflictDoUpdate() { return { async returning() {
      let row = imported.titles.find(item => item.imdbId === value.imdbId);
      if (!row) { row = { ...value, id: imported.titles.length + 1 }; imported.titles.push(row); }
      return [{ id: row.id }];
    } }; } };
    return { async onConflictDoNothing() { imported[table === tables.users ? 'users' : 'segments'].push(...(Array.isArray(value) ? value : [value])); } };
  } }; } };
}
const quiet = { log() {} };
const processStub = { argv: ['node', 'import-dump.ts', 'fixture.json'], env: {}, stdout: { write() {} }, exit(code) { assert.equal(code, 0); } };
const eq = (column, value) => ({ column, value });
async function exportScript() {
  let output;
  const run = new AsyncFunction('db', 'segments', 'titles', 'eq', 'writeFileSync', 'process', 'console', source('scripts/export-dump.ts'));
  await run(memoryDb(), tables.segments, tables.titles, eq, (_file, text) => { output = JSON.parse(text); }, processStub, quiet);
  return output;
}
async function importScript(dump) {
  const db = memoryDb();
  const run = new AsyncFunction('db', 'segments', 'titles', 'users', 'readFileSync', 'process', 'console', source('scripts/import-dump.ts'));
  await run(db, tables.segments, tables.titles, tables.users, () => JSON.stringify(dump), processStub, quiet);
  return db.imported;
}
async function apiDump() {
  const run = new AsyncFunction('db', 'segments', 'titles', 'eq', 'json', 'apiError', 'preflight', 'rateLimit', 'clientIp', 'process', source('src/app/api/dump/route.ts') + '\nreturn GET;');
  const get = await run(memoryDb(), tables.segments, tables.titles, eq, value => value, () => { throw new Error('unexpected API error'); }, () => null, () => ({ ok: true }), () => 'fixture', processStub);
  return get(new Request('https://fixture.invalid/api/dump'));
}
test('scheduled export round-trips title metadata and every status through the actual importer', async () => {
  const dump = await exportScript();
  assert.equal(dump.segments.length, fixture.length);
  assert.deepEqual(dump.segments.map(row => row.title), fixture.map(row => row.title.name));
  const restored = await importScript(dump);
  assert.equal(restored.segments.length, fixture.length);
  assert.equal(restored.titles.length, 2);
  assert.deepEqual(restored.segments.map(row => row.status), ['approved', 'pending', 'rejected']);
  assert.deepEqual(restored.segments.map(row => [row.imdbId, row.season, row.episode, row.startMs, row.endMs]), fixture.map(row => [row.segment.imdbId, row.segment.season, row.segment.episode, row.segment.startMs, row.segment.endMs]));
});
test('direct API dump remains approved-only and round-trips its approval/title metadata', async () => {
  const dump = await apiDump();
  assert.equal(dump.segments.length, 1);
  assert.equal(dump.segments[0].title, 'Fixture movie');
  assert.equal(dump.segments[0].status, 'approved');
  const restored = await importScript(dump);
  assert.equal(restored.segments.length, 1);
  assert.equal(restored.segments[0].status, 'approved');
});
test('negative control proves title-less dumps cannot populate the importer title-ID map', async () => {
  const dump = await exportScript();
  dump.segments.forEach(row => { delete row.title; });
  assert.equal((await importScript(dump)).segments.length, 0);
});
