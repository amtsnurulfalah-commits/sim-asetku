import "server-only";
import { auth } from "@/features/auth/server";
import { config } from "@/lib/config";
import { json } from "@/lib/security/http";
import { ApprovalController, type Action } from "./controller";
import { ApprovalService, mapApprovalError } from "./service";
export async function approvalDispatch(action: Action, r: Request) {
    try {
        return await new ApprovalController(new ApprovalService(auth()), config().APP_BASE_URL).handle(action, r);
    }
    catch (e) {
        const error = mapApprovalError(e);
        return json({
            success: false,
            error: { code: error.code, message: error.publicMessage },
        }, error.status);
    }
}
