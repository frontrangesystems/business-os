/**
 * Minimal, dependency-free PDF writer for test fixtures. Emits a valid
 * multi-page PDF with a proper xref table so poppler (pdfinfo / pdftotext /
 * pdftoppm) reads it exactly like a real document. Each page is an array of
 * text lines; an empty array yields a page with no text layer (forcing the
 * engine's image-only / vision path).
 */

function escapePdf(s: string): string {
  return s.replace(/([()\\])/g, '\\$1');
}

export function buildPdf(pages: string[][]): Buffer {
  const n = pages.length;
  const fontNum = 3 + n * 2;
  const objs = new Map<number, string>();

  objs.set(1, '<< /Type /Catalog /Pages 2 0 R >>');

  const kids: string[] = [];
  for (let i = 0; i < n; i++) {
    const pageNum = 3 + i * 2;
    const contentNum = 4 + i * 2;
    kids.push(`${pageNum} 0 R`);
    const lines = pages[i]!;
    const drawn = lines.length
      ? 'BT /F1 12 Tf 50 750 Td ' +
        lines
          .map((l, idx) => `${idx === 0 ? '' : '0 -16 Td '}(${escapePdf(l)}) Tj `)
          .join('') +
        'ET'
      : '';
    objs.set(
      pageNum,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`,
    );
    objs.set(
      contentNum,
      `<< /Length ${Buffer.byteLength(drawn, 'latin1')} >>\nstream\n${drawn}\nendstream`,
    );
  }

  objs.set(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`);
  objs.set(fontNum, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const maxNum = fontNum;
  let out = '%PDF-1.4\n';
  const offsets: number[] = new Array(maxNum + 1).fill(0);
  for (let num = 1; num <= maxNum; num++) {
    offsets[num] = Buffer.byteLength(out, 'latin1');
    out += `${num} 0 obj\n${objs.get(num)}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${maxNum + 1}\n`;
  out += '0000000000 65535 f \n';
  for (let num = 1; num <= maxNum; num++) {
    out += `${String(offsets[num]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${maxNum + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(out, 'latin1');
}
