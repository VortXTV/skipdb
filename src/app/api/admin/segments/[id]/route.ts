import { db } from "@/db";
import { segments, moderationLog } from "@/db/schema";
import { json, apiError } from "@/lib/api";
import { requireStaff } from "@/lib/admin";
import { recomputeResolved } from "@/lib/resolved";
import { applyReputationChange } from "@/lib/reputation";
import { READ_ONLY, readOnlyError } from "@/lib/read-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { SegmentTypeName } from "@/lib/config";

export const runtime = "nodejs";
const actionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  reason: z.string().max(500).optional(),
});
export async function POST(
  req: Request, { params }: { params: Promise<{ id: string }> },
) {
  if (READ_ONLY) return readOnlyError();
  const staff = await requireStaff();
  if (!staff) return apiError("Forbidden", 403);
  const { id } = await params;
  const segmentId = Number(id);
  if (!Number.isInteger(segmentId)) return apiError("Invalid id", 400);
  let body: unknown;
  try { body = await req.json(); } catch { return apiError("Invalid JSON body", 400); }
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) return apiError("action must be approve or reject", 422);
  const { action, reason } = parsed.data;
  const newStatus = action === "approve" ? "approved" : "rejected";
  const updated = await db.transaction(async (tx) => {
    const [before] = await tx.select().from(segments).where(eq(segments.id, segmentId)).for("update");
    if (!before) return null;
    const [after] = await tx.update(segments).set({
      status: newStatus, reviewedBy: staff.id, reviewedAt: new Date(),
      rejectionReason: action === "reject" ? (reason ?? null) : null, updatedAt: new Date(),
    }).where(eq(segments.id, segmentId)).returning();
    const reputationDelta = await applyReputationChange(tx, before.submittedBy, before, after);
    await tx.insert(moderationLog).values({
      segmentId, moderatorId: staff.id, action, reason: reason ?? null,
      detail: { fromStatus: before.status, toStatus: newStatus, reputationDelta },
    });
    return after;
  });
  if (!updated) return apiError("Segment not found", 404);
  await recomputeResolved({
    imdbId: updated.imdbId, titleId: updated.titleId, season: updated.season,
    episode: updated.episode, segmentType: updated.segmentType as SegmentTypeName,
  });
  return json({ id: segmentId, status: newStatus });
}
