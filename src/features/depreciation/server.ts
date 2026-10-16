import "server-only";
import { auth } from "@/features/auth/server";
import { config } from "@/lib/config";
import { json } from "@/lib/security/http";
import { DepreciationController, type Action } from "./controller";
import { DepreciationService, mapDepreciationError } from "./service";
export async function depreciationDispatch(action: Action, r: Request) {
    try {
        return await new DepreciationController(new DepreciationService(auth()), config().APP_BASE_URL).handle(action, r);
    }
    catch (e) {
        const error = mapDepreciationError(e);
        return json({
            success: false,
            error: { code: error.code, message: error.publicMessage },
        }, error.status);
    }
}
