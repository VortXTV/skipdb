import { db } from "@/db";
import { users } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { config } from "./config";
import { READ_ONLY } from "./read-only";

export type SegmentTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface ReputationState { status: string; score: number; }
export function segmentReputation(state: ReputationState | null): number {
  return state ? state.score + (state.status === "approved" ? config.review.reputationPerApproval : 0) : 0;
}
/** Apply only this transition's change; retain every pre-existing account balance.
 * Call inside the transaction holding the source segment's FOR UPDATE lock.
 * Atomic addition also preserves concurrent changes on other segments by this contributor. */
export async function applyReputationChange(
  tx: SegmentTransaction, userId: string | null,
  before: ReputationState | null, after: ReputationState | null,
): Promise<number> {
  if (READ_ONLY) throw new Error("This instance is read-only.");
  const delta = segmentReputation(after) - segmentReputation(before);
  if (userId && delta) await tx.update(users)
    .set({ reputation: sql`${users.reputation} + ${delta}` })
    .where(eq(users.id, userId));
  return delta;
}
