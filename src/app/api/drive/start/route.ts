import { driveDispatch } from "@/features/drive/server";
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";
export async function POST(r: Request) {
  return driveDispatch("start", r);
}
