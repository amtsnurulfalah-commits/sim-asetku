import "server-only";
import { TransactionService, mapTransactionError } from "./service";
import * as H from "@/lib/security/http";
import { AppError } from "@/lib/security/errors";
export type Action = 'options' | 'list' | 'assets' | 'detail' | 'save' | 'transition' | 'post' | 'observe' | 'policy' | 'link' | 'alerts' | 'scan' | 'files';
export class TransactionController {
    constructor(private service: TransactionService, private origin: string) { }
    async handle(action: Action, r: Request) {
        try {
            const get = ['options', 'list', 'assets', 'detail', 'alerts', 'scan', 'files'].includes(action);
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
            else if (action === 'list')
                data = await this.service.list(token, { kind: u.searchParams.get('kind') || undefined, status: u.searchParams.get('status') || 'all', query: u.searchParams.get('query') || '', page: u.searchParams.get('page') || 1 });
            else if (action === 'assets')
                data = await this.service.assets(token, { query: u.searchParams.get('query') || '', page: u.searchParams.get('page') || 1, parentId: u.searchParams.get('parentId') || null });
            else if (action === 'detail')
                data = await this.service.detail(token, u.searchParams.get('id') || '');
            else if(action==='files')data=await this.service.fileChoices(token,{query:u.searchParams.get('query')||'',page:u.searchParams.get('page')||1});
            else if (action === 'scan')
                data = await this.service.scan(token, u.searchParams.get('value') || '', this.origin);
            else if (action === 'alerts')
                data = await this.service.alerts(token);
            else {
                const body = await H.readJson(r, 64000);
                switch (action) {
                    case 'save':
                        data = await this.service.save(token, body);
                        break;
                    case 'transition':
                        data = await this.service.transition(token, body);
                        break;
                    case 'post':
                        data = await this.service.post(token, body);
                        break;
                    case 'observe':
                        data = await this.service.observe(token, body);
                        break;
                    case 'policy':
                        data = await this.service.policy(token, body);
                        break;
                    case 'link':
                        data = await this.service.link(token, body);
                        break;
                }
            }
            return H.json({ success: true, data });
        }
        catch (e) {
            const error = mapTransactionError(e);
            return H.json({
                success: false,
                error: { code: error.code, message: error.publicMessage },
            }, error.status);
        }
    }
}
