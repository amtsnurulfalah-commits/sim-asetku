import { dispatch } from "@/features/auth/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request) {
  return dispatch("tenants", request);
}
