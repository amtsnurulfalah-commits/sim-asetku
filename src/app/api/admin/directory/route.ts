import { adminDispatch } from "@/features/admin/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(r: Request) {
  return adminDispatch("directory", r);
}
