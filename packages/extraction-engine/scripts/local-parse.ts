/**
 * Local verification harness for the shared extraction engine.
 *
 * Runs parseDocument (render + OCR/text + item extraction + shape detection)
 * against a PDF on disk, prints the detected document shape, and — when the
 * document is narrative (Mode B) — runs extractScope against a trade checklist
 * and prints the scope findings. No DB, no framework boot.
 *
 * Usage (from the business-os repo root):
 *   ANTHROPIC_API_KEY=sk-ant-... \
 *     node_modules/.bin/tsx packages/extraction-engine/scripts/local-parse.ts \
 *       <pdf-path> [--pages A-B] [--model M] [--checklist "a,b,c"] [--out f.json]
 */
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseDocument,
  extractScope,
  createAnthropicVisionClient,
  CONSTRUCTION_BID_TAXONOMY,
  type ExtractionTaxonomy,
  type Logger,
  type Pricing,
} from '../src/index.js';

// Sonnet 4.6 per-MTok pricing (the model the field runs); override with --model.
const SONNET_PRICING: Pricing = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };

// Default concrete trade scope checklist (the mo-barracks probe list).
const DEFAULT_CHECKLIST = [
  'footings', 'grade beams', 'pile caps', 'slab on grade', 'elevated slabs',
  'foundation walls', 'retaining walls', 'columns', 'tilt panels / precast panels',
  'embeds and anchor bolts', 'lifting inserts', 'curbs and sidewalks',
  'equipment pads', 'joint sealants', 'reinforcing', 'formwork', 'finishing and curing',
  'testing and inspection', 'mix design approval', 'cold/hot weather concrete',
];

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  let pages: number[] | undefined;
  let model = 'claude-sonnet-4-6';
  let checklist = DEFAULT_CHECKLIST;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pages') {
      const m = (argv[++i] ?? '').match(/^(\d+)-(\d+)$/);
      if (!m) throw new Error('--pages expects A-B');
      pages = Array.from({ length: +m[2] - +m[1] + 1 }, (_, k) => +m[1] + k);
    } else if (a === '--model') model = argv[++i];
    else if (a === '--checklist') checklist = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') out = argv[++i];
    else pos.push(a);
  }
  if (pos.length !== 1) throw new Error('usage: local-parse.ts <pdf> [--pages A-B] [--model M] [--checklist "a,b"] [--out f]');
  return { pdfPath: pos[0], pages, model, checklist, out };
}

const logger: Logger = {
  info: (o, m) => console.error(`[info] ${m ?? ''}`, o),
  warn: (o, m) => console.error(`[warn] ${m ?? ''}`, o),
  error: (o, m) => console.error(`[error] ${m ?? ''}`, o),
};

async function main() {
  const { pdfPath, pages, model, checklist, out } = parseArgs(process.argv.slice(2));
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey?.startsWith('sk-ant-')) {
    console.error('ANTHROPIC_API_KEY not set / not an Anthropic key (export it, do not paste in chat).');
    process.exit(2);
  }
  const vision = createAnthropicVisionClient({ apiKey });
  const tmp = await mkdtemp(join(tmpdir(), 'engine-parse-'));

  // Generic building taxonomy: keep the default page types but drop the DOTD
  // domain wording, and attach the trade scope checklist for Mode B.
  const taxonomy: ExtractionTaxonomy = {
    ...CONSTRUCTION_BID_TAXONOMY,
    documentDescription: 'construction bid document (building / commercial project)',
    scopeChecklist: checklist,
  };

  try {
    const started = Date.now();
    const res = await parseDocument({
      vision, pdfPath, tmpDir: tmp, model, pricing: SONNET_PRICING,
      taxonomy, logger, pageSubset: pages, logId: 'local',
    });
    const secs = ((Date.now() - started) / 1000).toFixed(1);

    console.log('\n================ PARSE ================');
    console.log(`pages=${res.pageCount} scanned=${pages?.length ?? res.pageCount} vision=${res.visionPages} text=${res.textPages} items=${res.items.length} cost=$${res.costUsd.toFixed(2)} ${secs}s`);
    console.log(`SHAPE: ${res.shape.shape.toUpperCase()}  (${res.shape.reason})`);
    console.log(`  quantifiedItems=${res.shape.quantifiedItems} totalItems=${res.shape.totalItems} summaryPage=${res.shape.hasSummaryPage}`);

    let scope = null;
    if (res.shape.shape === 'narrative') {
      console.log('\n---- Mode B: scope checklist extraction ----');
      scope = await extractScope({
        vision, model, pricing: SONNET_PRICING, taxonomy,
        pageTexts: res.pageTexts, logger, logId: 'local-scope',
      });
      console.log(`covered ${scope.coveredCount}/${checklist.length} checklist items  |  +$${scope.costUsd.toFixed(2)}`);
      for (const item of checklist) {
        const f = scope.findings.find((x) => x.item === item);
        const mark = f ? (f.status === 'present' ? 'x' : '?') : ' ';
        const cites = f ? '  → ' + f.citations.map((c) => `p${c.page}`).join(', ') : '';
        console.log(`  [${mark}] ${item}${cites}`);
      }
      console.log('\n---- evidence ----');
      for (const f of scope.findings) {
        for (const c of f.citations.slice(0, 2)) console.log(`  ${f.item} (p${c.page}): «${c.snippet.slice(0, 90)}»`);
      }
    } else {
      console.log('\n---- Mode A items ----');
      for (const it of res.items.slice(0, 40)) console.log(`  • ${it.description} [${it.unit ?? '—'}${it.quantity != null ? ' qty ' + it.quantity : ''}] p${it.sourcePage}`);
    }

    if (out) {
      await writeFile(out, JSON.stringify({ shape: res.shape, items: res.items, scope }, null, 2));
      console.log(`\nwrote → ${out}`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
