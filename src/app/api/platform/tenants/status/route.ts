import { adminDispatch } from "@/features/admin/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(r: Request) {
  return adminDispatch("tenant-status", r);
}
