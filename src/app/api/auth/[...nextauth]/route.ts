import { handlers } from "@/lib/auth";
import { READ_ONLY, readOnlyError } from "@/lib/read-only";

export async function GET(...args: Parameters<typeof handlers.GET>) {
  if (READ_ONLY) return readOnlyError();
  return handlers.GET(...args);
}
export async function POST(...args: Parameters<typeof handlers.POST>) {
  if (READ_ONLY) return readOnlyError();
  return handlers.POST(...args);
}
