import "server-only";
import { DepreciationService, mapDepreciationError } from "./service";
import * as H from "@/lib/security/http";
import { AppError } from "@/lib/security/errors";
export type Action='options'|'list'|'detail'|'preview'|'save'|'post'|'ledger'|'sources'|'valuation';
export class DepreciationController {
    constructor(private service: DepreciationService, private origin: string) { }
    async handle(action: Action, r: Request) {
        try {
            const get=['options','list','detail','ledger','sources','valuation'].includes(action);
            if (r.method !== (get ? "GET" : "POST"))
                throw new AppError("METHOD_NOT_ALLOWED", 405, "Metode tidak didukung.");
            if (!get)
                H.assertCsrf(r, this.origin);
            const token = H.cookieValue(r, H.cookieNames(this.origin).session), u = new URL(r.url), session = await this.service.auth.session(token);
            if (r.headers.get("X-Tenant-Context") !== session.session.active_tenant_id)
                throw new AppError("TENANT_CONTEXT_CHANGED", 409, "Lembaga aktif berubah. Muat ulang halaman.");
            let data: unknown;
            if(action==='options')data=await this.service.options(token);
            else if(action==='list')data=await this.service.list(token,{page:u.searchParams.get('page')||1,query:u.searchParams.get('query')||'',status:u.searchParams.get('status')||'all'});
            else if(action==='detail')data=await this.service.detail(token,u.searchParams.get('id')||'');
            else if(action==='ledger')data=await this.service.ledger(token,{assetId:u.searchParams.get('assetId'),page:u.searchParams.get('page')||1});
            else if(action==='sources')data=await this.service.correctionSources(token,{query:u.searchParams.get('query')||'',page:u.searchParams.get('page')||1});
            else if(action==='valuation')data=await this.service.valuation(token,{period:u.searchParams.get('period'),page:u.searchParams.get('page')||1,query:u.searchParams.get('query')||'',roomId:u.searchParams.get('roomId')||null,categoryId:u.searchParams.get('categoryId')||null,postedBefore:u.searchParams.get('postedBefore')||null});
            else{const body=await H.readJson(r,64000);if(action==='preview')data=await this.service.preview(token,body);else if(action==='save')data=await this.service.save(token,body);else if(action==='post')data=await this.service.post(token,body);}
            return H.json({ success: true, data });
        }
        catch (e) {
            const error = mapDepreciationError(e);
            return H.json({
                success: false,
                error: { code: error.code, message: error.publicMessage },
            }, error.status);
        }
    }
}
