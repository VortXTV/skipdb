import "dotenv/config";
import { db, pool } from "../src/db";
import { segments } from "../src/db/schema";
import { recomputeResolved } from "../src/lib/resolved";
import { READ_ONLY } from "../src/lib/read-only";

async function main() {
  if (READ_ONLY) {
    throw new Error(
      "db:resolve refuses NEXT_PUBLIC_READ_ONLY=true. Pause application writers and run NEXT_PUBLIC_READ_ONLY=false pnpm db:resolve in a scoped maintenance process; keep the serving instance read-only.",
    );
  }
  const all = await db.select().from(segments);
  const groups = new Map(all.map((row) => [JSON.stringify([row.imdbId, row.season, row.episode, row.segmentType]), row]));
  for (const row of groups.values()) await recomputeResolved({
    imdbId: row.imdbId, titleId: row.titleId, season: row.season, episode: row.episode,
    segmentType: row.segmentType,
  });
  console.log(`Backfilled ${groups.size} resolved groups without clearing legacy cache history.`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => pool.end());
