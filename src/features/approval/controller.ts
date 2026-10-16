import "server-only";
import { ApprovalService, mapApprovalError } from "./service";
import * as H from "@/lib/security/http";
import { AppError } from "@/lib/security/errors";
export type Action = 'options' | 'workflows' | 'list' | 'detail' | 'document' | 'delegates' | 'publish' | 'state' | 'decide' | 'submit' | 'cancel' | 'return' | 'delegate' | 'history';
export class ApprovalController {
    constructor(private service: ApprovalService, private origin: string) { }
    async handle(action: Action, r: Request) {
        try {
            const get = ['options', 'workflows', 'list', 'detail', 'document', 'delegates', 'history'].includes(action);
            if (r.method !== (get ? "GET" : "POST"))
                throw new AppError("METHOD_NOT_ALLOWED", 405, "Metode tidak didukung.");
            if (!get)
                H.assertCsrf(r, this.origin);
            const token = H.cookieValue(r, H.cookieNames(this.origin).session), u = new URL(r.url), session = await this.service.auth.session(token);
            if (r.headers.get("X-Tenant-Context") !== session.session.active_tenant_id)
                throw new AppError("TENANT_CONTEXT_CHANGED", 409, "Lembaga aktif berubah. Muat ulang halaman.");
            let data: unknown;
            if (action === 'options')
                data = await this.service.options(token);
            else if (action === 'workflows')
                data = await this.service.workflows(token, { page: u.searchParams.get('page') || 1, query: u.searchParams.get('query') || '' });
            else if (action === 'list')
                data = await this.service.list(token, { page: u.searchParams.get('page') || 1, tab: u.searchParams.get('tab') || 'inbox', query: u.searchParams.get('query') || '', status: u.searchParams.get('status') || 'all' });
            else if (action === 'detail')
                data = await this.service.detail(token, u.searchParams.get('id') || '');
            else if (action === 'document')
                data = await this.service.forDocument(token, u.searchParams.get('id') || '');
            else if (action === 'history')
                data = await this.service.history(token, u.searchParams.get('id') || '');
            else if (action === 'delegates')
                data = await this.service.delegates(token, { page: u.searchParams.get('page') || 1 });
            else {
                const body = await H.readJson(r, 64000);
                switch (action) {
                    case 'publish':
                        data = await this.service.publish(token, body);
                        break;
                    case 'state':
                        data = await this.service.state(token, body);
                        break;
                    case 'decide':
                        data = await this.service.decide(token, body);
                        break;
                    case 'submit':
                        data = await this.service.submit(token, body);
                        break;
                    case 'cancel':
                        data = await this.service.cancel(token, body);
                        break;
                    case 'return':
                        data = await this.service.returnForRevision(token, body);
                        break;
                    case 'delegate':
                        data = await this.service.delegate(token, body);
                        break;
                }
            }
            return H.json({ success: true, data });
        }
        catch (e) {
            const error = mapApprovalError(e);
            return H.json({
                success: false,
                error: { code: error.code, message: error.publicMessage },
            }, error.status);
        }
    }
}
