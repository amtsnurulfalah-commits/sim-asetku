import "server-only";
import { auth } from "@/features/auth/server";
import { config } from "@/lib/config";
import { json } from "@/lib/security/http";
import { TransactionController, type Action } from "./controller";
import { TransactionService, mapTransactionError } from "./service";
export async function transactionDispatch(action: Action, r: Request) {
    try {
        return await new TransactionController(new TransactionService(auth()), config().APP_BASE_URL).handle(action, r);
    }
    catch (e) {
        const error = mapTransactionError(e);
        return json({
            success: false,
            error: { code: error.code, message: error.publicMessage },
        }, error.status);
    }
}
