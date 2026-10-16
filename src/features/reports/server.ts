import 'server-only';
import { auth } from '@/features/auth/server';
import { config } from '@/lib/config';
import { json } from '@/lib/security/http';
import { ReportService, reportError } from './service';
import { ReportController, type Action } from './controller';
export async function reportDispatch(action: Action, r: Request) { try {
    return await new ReportController(new ReportService(auth()), config().APP_BASE_URL).handle(action, r);
}
catch (e) {
    const x = reportError(e);
    return json({ success: false, error: { code: x.code, message: x.publicMessage } }, x.status);
} }
