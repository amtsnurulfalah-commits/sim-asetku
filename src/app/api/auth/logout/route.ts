import { dispatch } from "@/features/auth/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(request: Request) {
  return dispatch("logout", request);
}
