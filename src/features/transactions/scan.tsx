'use client';
import { useEffect, useRef, useState } from 'react';
import type { IScannerControls } from '@zxing/browser';
import { Button } from '@/components/ui/button';
export function OpnameScan({ onScan, disabled }: {
    onScan: (text: string) => Promise<void>;
    disabled: boolean;
}) {
    const video = useRef<HTMLVideoElement>(null), controls = useRef<IScannerControls | null>(null), alive = useRef(true), found = useRef(false);
    const [active, setActive] = useState(false), [busy, setBusy] = useState(false), [text, setText] = useState(''), [error, setError] = useState('');
    useEffect(() => { alive.current = true; return () => { alive.current = false; controls.current?.stop(); }; }, []);
    function stop() { controls.current?.stop(); controls.current = null; setActive(false); }
    async function resolve(text: string) { setBusy(true); setError(''); stop(); try {
        await onScan(text);
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        found.current = false;
        if (alive.current)
            setBusy(false);
    } }
    async function start() { setBusy(true); setError(''); found.current = false; try {
        if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext)
            throw Error('Kamera memerlukan HTTPS. Gunakan kode manual.');
        const { BrowserQRCodeReader } = await import('@zxing/browser');
        const c = await new BrowserQRCodeReader().decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } }, audio: false }, video.current!, (r) => { if (r && !found.current) {
            found.current = true;
            void resolve(r.getText());
        } });
        if (!alive.current)
            c.stop();
        else {
            controls.current = c;
            setActive(true);
        }
    }
    catch {
        setError('Kamera tidak tersedia. Gunakan kode manual.');
    }
    finally {
        if (alive.current)
            setBusy(false);
    } }
    return <div className="space-y-3 rounded-xl border p-4"><p className="text-sm">Pindai label untuk memilih aset dari snapshot periode ini.</p>{error && <p role="alert" className="text-red-700">{error}</p>}<video ref={video} muted playsInline className="aspect-video max-h-52 w-full rounded-lg bg-slate-950"/><div className="flex gap-3"><Button type="button" disabled={disabled || busy || active} onClick={start}>Aktifkan kamera</Button><Button type="button" variant="outline" disabled={!active} onClick={stop}>Hentikan</Button></div><label className="block">Kode inventaris atau URL QR<input className="field mt-2" maxLength={500} value={text} onChange={e => setText(e.target.value)}/></label><Button type="button" disabled={disabled || busy || !text.trim()} onClick={() => resolve(text)}>Pilih aset</Button></div>;
}
