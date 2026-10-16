import "server-only";
import { auth } from "@/features/auth/server";
import { config } from "@/lib/config";
import { json } from "@/lib/security/http";
import { mapAdminError } from "@/features/admin/service";
import { DriveController, type DriveAction } from "./controller";
import { driveService } from "./service";
export async function driveDispatch(action: DriveAction, r: Request) {
  try {
    return await new DriveController(
      driveService(auth()),
      config().APP_BASE_URL,
    ).handle(action, r);
  } catch (e) {
    const x = mapAdminError(e);
    return json(
      { success: false, error: { code: x.code, message: x.publicMessage } },
      x.status,
    );
  }
}
