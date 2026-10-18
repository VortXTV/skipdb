import { db } from "@/db";
import { segments, votes } from "@/db/schema";
import { json, apiError, preflight } from "@/lib/api";
import { getActor } from "@/lib/actor";
import { voteSchema } from "@/lib/validation";
import { recomputeResolved } from "@/lib/resolved";
import { applyReputationChange } from "@/lib/reputation";
import { and, eq, sql } from "drizzle-orm";
import type { SegmentTypeName } from "@/lib/config";
import { READ_ONLY, readOnlyError } from "@/lib/read-only";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export function OPTIONS() { return preflight(); }
export async function POST(
  req: Request, { params }: { params: Promise<{ id: string }> },
) {
  if (READ_ONLY) return readOnlyError();
  const actor = await getActor(req);
  if (!actor) return apiError("Authentication required.", 401);
  if (!rateLimit(`vote:${actor.user.id}`, 60).ok) return apiError("Rate limit exceeded", 429);
  const { id } = await params;
  const segmentId = Number(id);
  if (!Number.isInteger(segmentId)) return apiError("Invalid segment id", 400);
  let body: unknown;
  try { body = await req.json(); } catch { return apiError("Invalid JSON body", 400); }
  const parsed = voteSchema.safeParse(body);
  if (!parsed.success) return apiError("value must be 1, -1, or 0", 422);
  const value = parsed.data.value, userId = actor.user.id;
  const outcome = await db.transaction(async (tx) => {
    const [before] = await tx.select().from(segments).where(eq(segments.id, segmentId)).for("update");
    if (!before) return { error: apiError("Segment not found", 404) };
    if (before.submittedBy === userId) return { error: apiError("You cannot vote on your own segment", 403) };
    if (value === 0) {
      await tx.delete(votes).where(and(eq(votes.segmentId, segmentId), eq(votes.userId, userId)));
    } else {
      await tx.insert(votes).values({ segmentId, userId, value }).onConflictDoUpdate({
        target: [votes.segmentId, votes.userId], set: { value },
      });
    }
    const [agg] = await tx.select({
      up: sql<number>`coalesce(sum(case when ${votes.value} = 1 then 1 else 0 end), 0)`,
      down: sql<number>`coalesce(sum(case when ${votes.value} = -1 then 1 else 0 end), 0)`,
    }).from(votes).where(eq(votes.segmentId, segmentId));
    const up = Number(agg.up), down = Number(agg.down);
    const [after] = await tx.update(segments).set({ votesUp: up, votesDown: down, score: up - down })
      .where(eq(segments.id, segmentId)).returning();
    await applyReputationChange(tx, before.submittedBy, before, after);
    return { segment: after, up, down };
  });
  if ("error" in outcome) return outcome.error;
  const { segment, up, down } = outcome;
  if (segment.status === "approved") await recomputeResolved({
    imdbId: segment.imdbId, titleId: segment.titleId, season: segment.season,
    episode: segment.episode, segmentType: segment.segmentType as SegmentTypeName,
  });
  return json({ segment_id: segmentId, your_vote: value, votes: { up, down, score: up - down } });
}
