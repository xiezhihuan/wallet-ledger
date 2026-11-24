import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './config.js';
import { logger } from './log.js';

const log = logger('ocr');
/** 一个文字块：文字、位置、置信度 */
export interface OcrItem { t: string; x: number; y: number; w: number; h: number; c: number }
export interface OcrDoc { w: number; h: number; items: OcrItem[] }
export interface Ocr { recognize(file: string): Promise<OcrDoc> }

const MODEL = path.join(ROOT, 'models');
/** 检测模型会把长边压到 1920，长截图需切片才能看清小字。 */
const SLICE = 1800, OVERLAP = 240;

/**
 * 本地 OCR（PP-OCRv6 tiny，模型随项目分发，不联网）。
 * 依赖是可选安装的；不可用时返回 null，截图只保存、金额待用户补。
 */
export async function createOcr(): Promise<Ocr | null> {
  try {
    const { PaddleOcrService } = await import('ppu-paddle-ocr');
    const { loadImage, createCanvas } = await import('@napi-rs/canvas');
    const svc = new PaddleOcrService({
      model: { detection: path.join(MODEL, 'PP-OCRv6_tiny_det.ort'), recognition: path.join(MODEL, 'PP-OCRv6_tiny_rec.ort'), charactersDictionary: path.join(MODEL, 'ppocrv6_tiny_dict.txt') },
    });
    await svc.initialize();
    log.info('OCR 已就绪');
    type Img = Awaited<ReturnType<typeof loadImage>>;
    const run = async (c: import('@napi-rs/canvas').Canvas): Promise<OcrItem[]> => {
      const png = await c.encode('png');
      const r = await svc.recognize(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer, { noCache: true });
      return r.lines.flat().map((i) => ({ t: i.text, x: i.box.x, y: i.box.y, w: i.box.width, h: i.box.height, c: i.confidence }));
    };
    /** 检出了位置却没读出字（常见于红色价格）：裁出来、转灰度、拉对比度再读一次。 */
    const reread = async (img: Img, it: OcrItem): Promise<OcrItem | null> => {
      const pad = Math.round(it.h * 0.5), k = Math.max(1, 64 / it.h);
      const sx = Math.max(0, it.x - pad), sy = Math.max(0, it.y - pad), sw = Math.min(img.width - sx, it.w + pad * 2), sh = Math.min(img.height - sy, it.h + pad * 2);
      // 裁得太窄检测不到，四周补底色
      const m = 80, c = createCanvas(Math.round(sw * k) + m * 2, Math.round(sh * k) + m * 2), g = c.getContext('2d');
      g.drawImage(img, sx, sy, sw, sh, m, m, sw * k, sh * k);
      const d = g.getImageData(m, m, c.width - 2 * m, c.height - 2 * m), a = d.data;
      let lo = 255, hi = 0;
      for (let i = 0; i < a.length; i += 4) { const v = Math.min(a[i]!, a[i + 1]!, a[i + 2]!); a[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
      const bg = a[0]! > (lo + hi) / 2; // 背景亮 → 统一成白底黑字
      for (let i = 0; i < a.length; i += 4) { const v = ((a[i]! - lo) * 255) / Math.max(1, hi - lo), o = bg ? v : 255 - v; a[i] = a[i + 1] = a[i + 2] = o; a[i + 3] = 255; }
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.putImageData(d, m, m);
      const got = (await run(c)).filter((x) => x.t.trim());
      if (!got.length) return null;
      return { ...it, t: got.sort((p, q) => p.x - q.x).map((x) => x.t).join(''), c: Math.min(...got.map((x) => x.c)) };
    };
    return {
      async recognize(file) {
        const img = await loadImage(await fs.readFile(file));
        if (!img.width || !img.height) throw new Error('图片无法解码');
        if (img.width * img.height > 120_000_000) throw new Error('图片过大');
        const items: OcrItem[] = [];
        for (const { y, h, from, to } of slices(img.height)) {
          const c = createCanvas(img.width, h), g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, img.width, h); // 透明 PNG 铺白底
          g.drawImage(img, 0, y, img.width, h, 0, 0, img.width, h);
          for (const it of await run(c)) { const mid = y + it.y + it.h / 2; if (mid >= from && mid < to) items.push({ ...it, y: it.y + y }); }
        }
        const out: OcrItem[] = [];
        for (const it of items) {
          if (it.t.trim()) { out.push(it); continue; }
          const r = it.w > 20 && it.h > 8 ? await reread(img, it) : null;
          if (r) out.push(r);
        }
        return { w: img.width, h: img.height, items: out.map((i) => ({ t: i.t.trim(), x: Math.round(i.x), y: Math.round(i.y), w: Math.round(i.w), h: Math.round(i.h), c: Math.round(i.c * 100) / 100 })) };
      },
    };
  } catch (e) {
    log.warn(`OCR 不可用，截图将只保存不识别：${(e as Error).message}`);
    return null;
  }
}

/** 长图切片；重叠区从中线划分归属，每行文字按中心点只归一个切片，不重复不遗漏。 */
export function slices(height: number): { y: number; h: number; from: number; to: number }[] {
  const out: { y: number; h: number; from: number; to: number }[] = [];
  for (let y = 0; ; y += SLICE - OVERLAP) {
    const h = Math.min(SLICE, height - y), last = y + h >= height;
    out.push({ y, h, from: y === 0 ? 0 : y + OVERLAP / 2, to: last ? Infinity : y + h - OVERLAP / 2 });
    if (last) return out;
  }
}

/** 按行排好的纯文本，供搜索和展示 */
export function docText(d: OcrDoc): string {
  return rowsOf(d).map((r) => r.map((i) => i.t).join(' ')).join('\n').replace(/(?<=\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu, '');
}
/** 文字块聚成行 */
export function rowsOf(d: OcrDoc): OcrItem[][] {
  const rows: { mid: number; h: number; items: OcrItem[] }[] = [];
  for (const it of [...d.items].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2))) {
    const mid = it.y + it.h / 2, r = rows.at(-1);
    if (r && Math.abs(mid - r.mid) < Math.min(r.h, it.h) * 0.5) { r.items.push(it); r.mid = (r.mid * (r.items.length - 1) + mid) / r.items.length; r.h = Math.min(r.h, it.h); }
    else rows.push({ mid, h: it.h, items: [it] });
  }
  return rows.map((r) => r.items.sort((a, b) => a.x - b.x));
}
