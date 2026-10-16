import "server-only";
import { auth } from "@/features/auth/server";
import { config } from "@/lib/config";
import { json } from "@/lib/security/http";
import { SupplyController, type Action } from "./controller";
import { SupplyService, mapSupplyError } from "./service";
export async function supplyDispatch(action: Action, r: Request) {
  try {
    return await new SupplyController(
      new SupplyService(auth()),
      config().APP_BASE_URL,
    ).handle(action, r);
  } catch (e) {
    const error = mapSupplyError(e);
    return json(
      {
        success: false,
        error: { code: error.code, message: error.publicMessage },
      },
      error.status,
    );
  }
}
