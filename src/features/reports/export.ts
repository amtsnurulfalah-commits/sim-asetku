import 'server-only';
import {AppError} from '@/lib/security/errors';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, rgb, type PDFImage, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import ExcelJS from 'exceljs';
import type { Table } from './schemas';
export function decimal(value: string) { const [n, d = ''] = value.split('.'); return n.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + d.padEnd(2, '0'); }
const text = (s: unknown) => String(s ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
export function wrap(s: string, font: PDFFont, size: number, width: number) { const result: string[] = []; for (const paragraph of text(s).split('\n')) {
    let line = '';
    for (const token of paragraph.split(/(\s+)/)) {
        if (!line && !token.trim())
            continue;
        if (line && font.widthOfTextAtSize(line + token, size) > width) {
            result.push(line.trimEnd());
            line = '';
        }
        for (const ch of token) {
            if (!line && !ch.trim())
                continue;
            if (line && font.widthOfTextAtSize(line + ch, size) > width) {
                result.push(line.trimEnd());
                line = '';
            }
            line += ch;
        }
    }
    result.push(line.trimEnd());
} return result; }
export async function reportPdf(t: Table, logo?: Uint8Array) {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(await readFile(path.join(process.cwd(), 'assets/fonts/DejaVuSans.ttf')), { subset: true });
    doc.setTitle(t.title);
    doc.setCreator('Inventaris Madrasah/Sekolah');
    const width = 841.89, height = 595.28, margin = 32, usable = width - 2 * margin;
    let page = doc.addPage([width, height]), y = height - margin;
    const pages: typeof page[] = [];
    pages.push(page);
    let image:PDFImage|undefined;
    if (logo) {
        image = logo[0] === 0x89 ? await doc.embedPng(logo) : await doc.embedJpg(logo);
    }
    const line = (s: string, size = 9, color = rgb(.12, .18, .24)) => { page.drawText(text(s), { x: margin, y, size, font, color }); y -= size + 5; };
    const newPage = () => { if(pages.length>=250)throw new AppError('REPORT_SIZE',409,'PDF melebihi 250 halaman. Persempit filter atau kurangi kolom.'); page = doc.addPage([width, height]); pages.push(page); y = height - margin; for(const l of wrap(t.meta.tenant.name,font,11,usable))line(l,11); for(const l of wrap(t.title,font,10,usable))line(l,10); line(t.number, 8); y -= 8; };
    const block = (s: string, size = 9) => { for (const l of wrap(s, font, size, usable)) {
        if (y < margin + 40)
            newPage();
        line(l, size);
    } };
    if (image) {
        const fit = image.scaleToFit(46, 46);
        page.drawImage(image, { x: margin, y: y - 44, width: fit.width, height: fit.height });
    }
    const nameLines=wrap(t.meta.tenant.name,font,16,usable-(image?60:0));
    nameLines.forEach((name,i)=>page.drawText(name,{x:margin+(image?60:0),y:y-i*20,size:16,font,color:rgb(.04,.35,.33)}));
    y-=Math.max(image?60:24,nameLines.length*20+4);
    block(t.meta.config.letterhead || [t.meta.tenant.profile.address, t.meta.tenant.profile.npsn && 'NPSN ' + t.meta.tenant.profile.npsn, t.meta.tenant.profile.nsm && 'NSM ' + t.meta.tenant.profile.nsm].filter(Boolean).join(' · '));
    y -= 8;
    block(t.title, 13);
    block('Nomor: ' + t.number + ' · Dibuat: ' + new Date(t.generatedAt).toLocaleString('id-ID', { timeZone: t.meta.tenant.timezone }), 8);
    block('Format tenant versi ' + t.meta.templateVersion + ' · ' + t.count + ' baris · Periode valuasi ' + t.filters.period, 8);
    block('Filter: ' + filterSummary(t), 8);
    if (t.status !== 'posted' && t.filters.kind === 'minutes')
        block('DRAF - BELUM FINAL', 12);
    y -= 8;
    const n = t.columns.length, colwidth = usable / n, size = 7.5, padding = 5;
    const header = () => { if (y < 100)
        newPage(); const lines = t.columns.map(c => wrap(c.label, font, size, colwidth - 10)), h = Math.max(...lines.map(l => l.length)) * 11 + 12; page.drawRectangle({ x: margin, y: y - h, width: usable, height: h, color: rgb(.06, .38, .36) }); lines.forEach((ls, i) => ls.forEach((s, j) => page.drawText(s, { x: margin + i * colwidth + padding, y: y - 12 - j * 11, size, font, color: rgb(1, 1, 1) }))); y -= h; };
    header();
    for (const row of t.rows) {
        const ls = t.columns.map(c => wrap(c.money && row[c.key] != null ? decimal(row[c.key]!) : text(row[c.key]), font, size, colwidth - 10));
        let offset = 0;
        const max = Math.max(1, ...ls.map(l => l.length));
        while (offset < max) {
            if (y < margin + 64) {
                newPage();
                header();
            }
            const available = Math.max(1, Math.floor((y - margin - 40 - 12) / 11)), take = Math.min(available, max - offset), h = take * 11 + 12;
            t.columns.forEach((_, i) => { page.drawRectangle({ x: margin + i * colwidth, y: y - h, width: colwidth, height: h, borderColor: rgb(.8, .85, .85), borderWidth: .4 }); ls[i].slice(offset, offset + take).forEach((s, j) => page.drawText(s, { x: margin + i * colwidth + padding, y: y - 12 - j * 11, size, font, color: rgb(.12, .18, .24) })); });
            y -= h;
            offset += take;
            if (offset < max) {
                newPage();
                header();
            }
        }
    }
    if (!t.rows.length)
        block('Tidak ada data sesuai filter.');
    y -= 12;
    for (const [k, v] of Object.entries(t.totals))
        block('Total ' + ({ cost: 'perolehan', expense: 'beban periode', accumulated: 'akumulasi', book: 'nilai buku', value: 'nilai persediaan' }[k] ?? k) + ': Rp ' + decimal(v), 9);
    for (const note of t.notes) {
        y -= 4;
        block(note, 8);
    }
    if (t.approval?.length) {
        y -= 8;
        block('Jejak persetujuan', 10);
        for (const a of t.approval)
            block(a, 8);
    }
    if (y < 220)
        newPage();
    y -= 20;
    const step = usable / t.meta.config.signers.length;
    for (const [i, s] of t.meta.config.signers.entries()) {
        const x = margin + i * step;
        for (const [j, l] of wrap(s.role, font, 9, step - 15).entries())
            page.drawText(l, { x, y: y - j * 13, size: 9, font });
        page.drawLine({ start: { x, y: y - 65 }, end: { x: x + Math.min(190, step - 20), y: y - 65 }, thickness: .4 });
        for (const [j, l] of wrap(s.name || 'Nama pejabat diisi', font, 9, step - 15).entries())
            page.drawText(l, { x, y: y - 80 - j * 13, size: 9, font });
    }
    y -= 130;
    for(const l of wrap(t.meta.config.footer,font,7,usable)){if(y<margin+7)newPage();line(l,7);}
    pages.forEach((p, i) => p.drawText(`${t.number} · ${i + 1}/${pages.length}`, { x: margin, y: 18, size: 7, font, color: rgb(.4, .45, .5) }));
    return Buffer.from(await doc.save());
}
export function filterSummary(t: Table) { const f = t.filters, o = t.meta; const name = (id: string | null, refs: {
    id: string;
    name: string;
}[]) => id ? refs.find(r => r.id === id)?.name ?? 'Referensi tersimpan' : 'Semua'; return [`Gedung ${name(f.buildingId, o.buildings)}`, `Ruangan ${name(f.roomId, o.rooms)}`, `Kategori ${name(f.categoryId, o.categories)}`, `Kondisi ${name(f.conditionId, o.conditions)}`, `Dana ${name(f.fundingId, o.funding)}`, `Tahun ${f.year ?? 'semua'}`, `Status ${f.status}`, `Kelompok ${f.group}`, `Tanggal ${f.from ?? 'awal'} s.d. ${f.to ?? 'akhir'}`, `Jenis transaksi ${f.transactionType}`, `Status dokumen ${f.documentStatus}`, `Cari ${f.query || 'semua'}`, `Posting sampai ${f.postedBefore ?? 'kini'}`].join(' · '); }
export async function reportXlsx(t: Table, logo?: Uint8Array) {
    const w = new ExcelJS.Workbook();
    w.creator = 'Inventaris Madrasah/Sekolah';
    w.created = new Date(t.generatedAt);
    const s = w.addWorksheet('Laporan', { pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } }), n = t.columns.length;
    const merged = (v: string) => { const parts = text(v).match(/[\s\S]{1,900}/g) ?? ['']; let first: ExcelJS.Row | undefined; for (const part of parts) {
        const r = s.addRow([part]);
        first ??= r;
        s.mergeCells(r.number, 1, r.number, n);
        r.alignment = { wrapText: true, vertical: 'middle' };
        r.height = Math.min(400, Math.max(25, Math.ceil(part.length / Math.max(30, n * 18)) * 17));
    } return first!; };
    if (logo) { merged('').height=48;
        const id = w.addImage({ buffer: Buffer.from(logo) as unknown as ExcelJS.Buffer, extension: logo[0] === 0x89 ? 'png' : 'jpeg' });
        s.addImage(id, { tl: { col: 0, row: 0 }, ext: { width: 42, height: 42 } });
    }
    const nameRow=merged(t.meta.tenant.name);nameRow.font={bold:true,size:17,color:{argb:'FF0F766E'}};nameRow.height=Math.max(nameRow.height??25,Math.ceil(t.meta.tenant.name.length/(n*16))*24);
    merged(t.meta.config.letterhead || t.meta.tenant.profile.address || '');
    merged(t.title).font = { bold: true, size: 14 };
    merged(t.number + ' · ' + t.generatedAt + ' · Format versi ' + t.meta.templateVersion);
    merged(filterSummary(t));
    if (t.status !== 'posted' && t.filters.kind === 'minutes')
        merged('DRAF - BELUM FINAL');
    const h = s.addRow(t.columns.map(c => c.label));
    h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
    h.height = 30;
    h.alignment = { wrapText: true, vertical: 'middle' };
    s.views = [{ state: 'frozen', ySplit: h.number }];
    s.autoFilter = { from: { row: h.number, column: 1 }, to: { row: h.number, column: n } };
    for (const row of t.rows) {
        const cells = t.columns.map(c => text(row[c.key]).match(/[\s\S]{1,450}/g) ?? ['']);
        const count = Math.max(...cells.map(c => c.length));
        for (let part = 0; part < count; part++) {
            const values = cells.map(c => c[part] ?? '');
            const r = s.addRow(values);
            r.alignment = { wrapText: true, vertical: 'top' };
            r.height = Math.max(25, ...values.map(v => Math.ceil(v.length / 22) * 17));
            r.eachCell(c => { c.numFmt = '@'; c.border = { bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } } }; });
        }
    }
    s.columns.forEach((c, i) => { c.width = i === 1 ? 38 : 24; });
    s.pageSetup.printTitlesRow = `${h.number}:${h.number}`;
    for (const [k, v] of Object.entries(t.totals))
        merged(`Total ${k}: ${v}`);
    for (const a of [...t.notes, ...t.approval ?? []])
        merged(a);
    merged('');
    for (const signer of t.meta.config.signers) {
        merged(signer.role);
        merged('');
        merged('________________________');
        merged(signer.name || 'Nama pejabat diisi');
    }
    merged(t.meta.config.footer);
    const m = w.addWorksheet('Metadata');
    for (const [k, v] of Object.entries({ tenant: t.meta.tenant.name, nomor: t.number, judul: t.title, waktu: t.generatedAt, baris: String(t.count), template: String(t.meta.templateVersion), filters: JSON.stringify(t.filters), precision: 'Nilai dan kuantitas disimpan sebagai teks desimal eksak; tidak ada formula atau pembulatan IEEE-754 otomatis.' })) {
        m.addRow([k, v]);
    }
    m.columns = [{ width: 24 }, { width: 110 }];
    m.eachRow(r => { r.alignment = { wrapText: true, vertical: 'top' }; r.height = Math.min(400, Math.max(30, Math.ceil(String(r.getCell(2).value ?? '').length / 95) * 17)); });
    return Buffer.from(await w.xlsx.writeBuffer());
}
