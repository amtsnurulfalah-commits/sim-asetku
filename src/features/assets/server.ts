import "server-only";
import { auth } from "@/features/auth/server";
import { config } from "@/lib/config";
import { json } from "@/lib/security/http";
import { mapAssetError } from "./service";
import { AssetController, type AssetAction } from "./controller";
import { AssetService } from "./service";
export async function assetDispatch(action: AssetAction, r: Request) {
  try {
    return await new AssetController(
      new AssetService(auth()),
      config().APP_BASE_URL,
    ).handle(action, r);
  } catch (e) {
    const x = mapAssetError(e);
    return json(
      { success: false, error: { code: x.code, message: x.publicMessage } },
      x.status,
    );
  }
}
