import 'server-only';
import { z } from 'zod';
import { filters } from './schemas';
import * as H from '@/lib/security/http';
import { AppError } from '@/lib/security/errors';
import { ReportService, reportError } from './service';
export type Action = 'options' | 'configure' | 'preview' | 'dashboard' | 'export' | 'history';
export class ReportController {
    constructor(private service: ReportService, private origin: string) { }
    async handle(action: Action, r: Request) { try {
        const get = ['options', 'history'].includes(action);
        if (r.method !== (get ? 'GET' : 'POST'))
            throw new AppError('METHOD_NOT_ALLOWED', 405, 'Metode tidak didukung.');
        if (!get)
            H.assertCsrf(r, this.origin);
        const t = H.cookieValue(r, H.cookieNames(this.origin).session), x = await this.service.auth.session(t);
        if (r.headers.get('X-Tenant-Context') !== x.session.active_tenant_id)
            throw new AppError('TENANT_CONTEXT_CHANGED', 409, 'Lembaga aktif berubah. Muat ulang halaman.');
        let data;
        if (action === 'options')
            data = await this.service.options(t);
        else if (action === 'history')
            data = await this.service.history(t, new URL(r.url).searchParams.get('page') || 1);
        else {
            const b = await H.readJson(r, 32000);
            if (action === 'configure')
                data = await this.service.configure(t, b);
            else if (action === 'dashboard')
                data = await this.service.dashboard(t, b);
            else if (action === 'preview') {
                const v = this.service.parse(z.object({ filters, page: z.number().int().min(1).max(200) }).strict(), b);
                data = await this.service.preview(t, v.filters, v.page);
            }
            else {
                const f = await this.service.export(t, b);
                return new Response(new Uint8Array(f.bytes), { headers: { 'Content-Type': f.mime, 'Content-Disposition': `attachment; filename="${f.name}"`, 'Content-Length': String(f.bytes.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
            }
        }
        return H.json({ success: true, data });
    }
    catch (e) {
        const x = reportError(e);
        return H.json({ success: false, error: { code: x.code, message: x.publicMessage } }, x.status);
    } }
}
