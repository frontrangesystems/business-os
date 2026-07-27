import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ResolvedTuning } from './config.js';

const execFileAsync = promisify(execFile);

/** PDF page dimensions in points (1/72 inch). */
export interface PageDims {
  widthPt: number;
  heightPt: number;
}

export async function pageCountOf(pdf: string): Promise<number> {
  const { stdout } = await execFileAsync('pdfinfo', [pdf], { encoding: 'utf8' });
  const line = stdout.split('\n').find((l) => l.startsWith('Pages:'));
  if (!line) throw new Error('pdfinfo: no Pages line');
  return Number(line.split(/\s+/)[1]);
}

/** Per-page dimensions in points, via a single `pdfinfo -f 1 -l N` call. */
export async function pageDimsOf(
  pdf: string,
  pageCount: number,
): Promise<Map<number, PageDims>> {
  const map = new Map<number, PageDims>();
  const { stdout } = await execFileAsync(
    'pdfinfo',
    ['-f', '1', '-l', String(pageCount), pdf],
    { encoding: 'utf8' },
  );
  const re = /Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    map.set(Number(m[1]), { widthPt: Number(m[2]), heightPt: Number(m[3]) });
  }
  return map;
}

/**
 * Pick a render DPI for a page so its longest side stays <= maxImagePx.
 * px = pts / 72 * dpi. Never upscale above the default DPI.
 */
export function dpiForPage(dims: PageDims | undefined, tuning: ResolvedTuning): number {
  if (!dims) return tuning.dpi;
  const longestPt = Math.max(dims.widthPt, dims.heightPt);
  const longestInch = longestPt / 72;
  if (longestInch <= 0) return tuning.dpi;
  const maxDpi = Math.floor(tuning.maxImagePx / longestInch);
  return Math.max(36, Math.min(tuning.dpi, maxDpi));
}

/**
 * Render every page to JPEG, picking a per-page DPI so no render exceeds the
 * px cap. Pages at the default DPI render in one bulk pdftoppm call; oversized
 * pages render individually at a bounded DPI. Returns page -> file path.
 */
export async function renderAll(
  pdf: string,
  outDir: string,
  pageCount: number,
  pageDims: Map<number, PageDims>,
  tuning: ResolvedTuning,
): Promise<Map<number, string>> {
  const map = new Map<number, string>();

  const defaultPages: number[] = [];
  const customPages: number[] = [];
  for (let p = 1; p <= pageCount; p++) {
    if (dpiForPage(pageDims.get(p), tuning) >= tuning.dpi) defaultPages.push(p);
    else customPages.push(p);
  }

  if (defaultPages.length > 0) {
    await execFileAsync('pdftoppm', [
      '-r', String(tuning.dpi),
      '-jpeg',
      '-jpegopt', 'quality=75',
      pdf,
      join(outDir, 'pg'),
    ]);
    const files = await readdir(outDir);
    for (const p of defaultPages) {
      const re = new RegExp(`-0*${p}\\.jpg$`);
      const file = files.find((f) => re.test(f));
      if (file) map.set(p, join(outDir, file));
    }
  }

  for (const p of customPages) {
    const dpi = dpiForPage(pageDims.get(p), tuning);
    const prefix = join(outDir, `pg-custom-${p}`);
    await execFileAsync('pdftoppm', [
      '-r', String(dpi),
      '-f', String(p),
      '-l', String(p),
      '-jpeg',
      '-jpegopt', 'quality=75',
      '-singlefile',
      pdf,
      prefix,
    ]);
    map.set(p, `${prefix}.jpg`);
  }

  return map;
}

/** Render one cropped tile region (device px at `dpi`) straight from the PDF. */
export async function renderTile(
  pdf: string,
  page: number,
  dpi: number,
  region: { x: number; y: number; w: number; h: number },
  prefix: string,
): Promise<string> {
  await execFileAsync('pdftoppm', [
    '-r', String(dpi),
    '-f', String(page),
    '-l', String(page),
    '-x', String(region.x),
    '-y', String(region.y),
    '-W', String(region.w),
    '-H', String(region.h),
    '-jpeg',
    '-jpegopt', 'quality=75',
    '-singlefile',
    pdf,
    prefix,
  ]);
  return `${prefix}.jpg`;
}

/** Text layer for one page via `pdftotext -layout`. */
export async function textLayer(pdf: string, page: number): Promise<string> {
  const { stdout } = await execFileAsync('pdftotext', [
    '-layout',
    '-f', String(page),
    '-l', String(page),
    pdf,
    '-',
  ]);
  return stdout;
}
