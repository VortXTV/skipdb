import { db } from "@/db";
import { segments, resolvedSegments } from "@/db/schema";
import { and, eq, isNull, desc, sql } from "drizzle-orm";
import type { SegmentTypeName } from "./config";
import { config } from "./config";
import { computeConfidence, countAgreement } from "./confidence";
import { READ_ONLY } from "./read-only";

const seasonCond = (season: number | null) => season == null ? isNull(segments.season) : eq(segments.season, season);
const episodeCond = (episode: number | null) => episode == null ? isNull(segments.episode) : eq(segments.episode, episode);
const rSeasonCond = (season: number | null) => season == null ? isNull(resolvedSegments.season) : eq(resolvedSegments.season, season);
const rEpisodeCond = (episode: number | null) => episode == null ? isNull(resolvedSegments.episode) : eq(resolvedSegments.episode, episode);
export interface ResolveKey { imdbId: string; titleId: number; season: number | null; episode: number | null; segmentType: SegmentTypeName; }

/** Serialize each group before selecting; upsert its unique JSONB composite key.
 * JSON null is distinct from season/episode zero. Legacy cache rows are never rewritten. */
export async function recomputeResolved(key: ResolveKey): Promise<void> {
  if (READ_ONLY) return;
  const cacheKey: [string, number | null, number | null, string] =
    [key.imdbId, key.season ?? null, key.episode ?? null, key.segmentType];
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(cacheKey)}, 0))`);
    const approved = await tx.select().from(segments).where(and(
      eq(segments.imdbId, key.imdbId), eq(segments.segmentType, key.segmentType),
      eq(segments.status, "approved"), seasonCond(key.season), episodeCond(key.episode),
    )).orderBy(desc(segments.score), desc(segments.votesUp), desc(segments.createdAt), desc(segments.id));
    const best = approved[0];
    if (!best) {
      await tx.delete(resolvedSegments).where(eq(resolvedSegments.cacheKey, cacheKey));
      return;
    }
    const value = {
      cacheKey, imdbId: key.imdbId, titleId: best.titleId, season: key.season, episode: key.episode,
      segmentType: key.segmentType, segmentId: best.id, startMs: best.startMs, endMs: best.endMs,
      durationMs: best.durationMs, votesUp: best.votesUp, votesDown: best.votesDown, score: best.score,
      confidence: computeConfidence({ agreeCount: countAgreement(best, approved), votesUp: best.votesUp, votesDown: best.votesDown }),
      updatedAt: new Date(),
    };
    await tx.insert(resolvedSegments).values(value).onConflictDoUpdate({
      target: resolvedSegments.cacheKey, set: value,
    });
  });
}
export async function recomputeAllTypes(key: Omit<ResolveKey, "segmentType">): Promise<void> {
  for (const segmentType of config.segmentTypes) await recomputeResolved({ ...key, segmentType });
}
export async function getResolved(q: { imdbId: string; season: number | null; episode: number | null; }) {
  return db.select().from(resolvedSegments).where(and(
    eq(resolvedSegments.imdbId, q.imdbId), rSeasonCond(q.season), rEpisodeCond(q.episode),
  ));
}
