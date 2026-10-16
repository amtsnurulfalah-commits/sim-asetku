import "server-only";
import { AppError } from "@/lib/security/errors";
import { readFile } from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";
import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { assetUrl } from "./qr";
export const qrPng = (origin: string, id: string) =>
  QRCode.toBuffer(assetUrl(origin, id), {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 4,
    width: 512,
  });
function lines(
  text: string,
  font: PDFFont,
  size: number,
  width: number,
  max: number,
) {
  const tokens = text.replace(/[\r\n\t]+/g, " ").split(/(?<=[ /-])/u),
    result: string[] = [];
  let line = "";
  for (const token of tokens) {
    if (line && font.widthOfTextAtSize(line + token, size) > width) {
      result.push(line.trim());
      line = "";
    }
    for (const char of Array.from(token)) {
      if (line && font.widthOfTextAtSize(line + char, size) > width) {
        result.push(line.trim());
        line = "";
      }
      line += char;
    }
  }
  if (line.trim()) result.push(line.trim());
  if (result.length > max) {
    result.length = max;
    let last = result[max - 1];
    while (last && font.widthOfTextAtSize(last + "…", size) > width)
      last = last.slice(0, -1);
    result[max - 1] = last + "…";
  }
  return result;
}
export async function labelPdf(
  input: {
    rows: { public_id: string; inventory_code: string; name: string }[];
    tenantName: string;
    width: number;
    height: number;
  },
  origin: string,
) {
  const mm = 72 / 25.4,
    w = input.width * mm,
    h = input.height * mm,
    gap = 2 * mm,
    margin = 10 * mm;
  if (
    input.rows.length < 1 ||
    input.rows.length > 100 ||
    input.width < 50 ||
    input.width > 100 ||
    input.height < 30 ||
    input.height > 60
  )
    throw new Error("Invalid label layout");
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(
    await readFile(path.join(process.cwd(), "assets/fonts/DejaVuSans.ttf")),
    { subset: true },
  );
  doc.setTitle("Label Aset Inventaris");
  doc.setCreator("Inventaris Madrasah/Sekolah");
  const pw = 210 * mm,
    ph = 297 * mm,
    cols = Math.floor((pw - 2 * margin + gap) / (w + gap)),
    rows = Math.floor((ph - 2 * margin + gap) / (h + gap)),
    perPage = cols * rows;
  for (let i = 0; i < input.rows.length; i++) {
    const item = input.rows[i],
      slot = i % perPage,
      page = slot === 0 ? doc.addPage([pw, ph]) : doc.getPages().at(-1)!;
    const x = margin + (slot % cols) * (w + gap),
      y = ph - margin - h - Math.floor(slot / cols) * (h + gap);
    page.drawRectangle({
      x,
      y,
      width: w,
      height: h,
      borderColor: rgb(0.78, 0.81, 0.82),
      borderWidth: 0.35,
      color: rgb(1, 1, 1),
    });
    const q = Math.min(input.height - 7, 27) * mm,
      px = x + 2 * mm,
      py = y + (h - q) / 2,
      qr = await doc.embedPng(await qrPng(origin, item.public_id));
    page.drawImage(qr, { x: px, y: py, width: q, height: q });
    const tx = px + q + 2 * mm,
      tw = x + w - 2 * mm - tx;
    let ty = y + h - 4 * mm;
    for (const [text, size, max, color] of [
      [input.tenantName, 7, 2, rgb(0.1, 0.28, 0.28)],
      [item.name, 7.5, 2, rgb(0.05, 0.08, 0.1)],
      [item.inventory_code, 6.5, 3, rgb(0.25, 0.3, 0.33)],
    ] as const) {
      const wrapped = lines(text, font, size, tw, max);
      if (size === 6.5 && wrapped.some((line) => line.includes("…")))
        throw new AppError(
          "LABEL_CODE_TOO_LONG",
          400,
          "Kode inventaris terlalu panjang untuk ukuran label. Perbesar ukuran label sebelum mencetak.",
        );
      for (const line of wrapped) {
        page.drawText(line, { x: tx, y: ty, font, size, color });
        ty -= size + 2;
      }
      ty -= 3;
    }
  }
  return doc.save();
}
