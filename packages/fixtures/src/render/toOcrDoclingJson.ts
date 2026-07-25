import type { PageLayout } from "../layout/invoiceLayout";
import { opWidth } from "../layout/invoiceLayout";

/**
 * PageLayout -> DoclingDocument JSON, Path C's input shape: word-level text
 * items and NO `tables` key at all. OCR runs with do_table_structure=false,
 * so TableFormer never produces a `tables[]` region — table content only
 * reaches the document as ordinary words sitting in the table's x-bands, and
 * `applyTemplateOcr` reconstructs columns from those bands. Unlike
 * toDoclingJson, `tableHeader`/`cell` ops are NOT special-cased here — they
 * become words exactly like every other op.
 */

export interface RenderOcrDoclingJsonOptions {
  jitterPt?: number;
  lowercaseIbans?: boolean;
  dropTokenRate?: number;
}

/** Vertical padding added below the font size to approximate a word cell's height. */
const WORD_PAD = 4;

/** Shape checksums.ts's isValidIban expects, case-insensitively (INVEX-036: the real scan is case-sensitive and misses lowercase OCR). */
const IBAN_SHAPE = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/i;

// FNV-1a. Fast, dependency-free, and — the point of it — pure: Math.random()
// would make fixtures non-reproducible across runs, and the same (word, index)
// pair must always jitter/drop identically for byte-reproducible fixtures.
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic value in [0,1), keyed by an arbitrary seed string. */
function unit(seed: string): number {
  return hash32(seed) / 0xffffffff;
}

export function renderOcrDoclingJson(pages: PageLayout[], opts: RenderOcrDoclingJsonOptions = {}): unknown {
  const jitterPt = opts.jitterPt ?? 0;
  const lowercaseIbans = opts.lowercaseIbans ?? false;
  const dropTokenRate = opts.dropTokenRate ?? 0;

  const texts: unknown[] = [];
  const pagesOut: Record<string, unknown> = {};
  let tokenIdx = 0;

  for (const page of pages) {
    pagesOut[String(page.page)] = { size: { width: page.widthPt, height: page.heightPt }, page_no: page.page };

    for (const op of page.ops) {
      const wordRe = /\S+/g;
      let m: RegExpExecArray | null;
      while ((m = wordRe.exec(op.text))) {
        const word = m[0];
        const idx = tokenIdx++;
        const seed = `${word}:${idx}`;

        if (dropTokenRate > 0 && unit(`${seed}:drop`) < dropTokenRate) continue;

        // Advance by the width of everything before this word in the same op
        // (reusing opWidth, not reimplementing its char-width ratio).
        const prefix = op.text.slice(0, m.index);
        const x = op.x + opWidth({ ...op, text: prefix });
        const w = opWidth({ ...op, text: word });

        const dx = jitterPt > 0 ? (unit(`${seed}:dx`) * 2 - 1) * jitterPt : 0;
        const dy = jitterPt > 0 ? (unit(`${seed}:dy`) * 2 - 1) * jitterPt : 0;

        const outText = lowercaseIbans && IBAN_SHAPE.test(word) ? word.toLowerCase() : word;

        const l = x + dx;
        const r = l + w;
        const t = op.yTop + dy;
        const b = t + op.size + WORD_PAD;

        texts.push({
          label: "text",
          text: outText,
          prov: [
            {
              page_no: page.page,
              bbox: { l, r, t: page.heightPt - t, b: page.heightPt - b, coord_origin: "BOTTOMLEFT" },
            },
          ],
        });
      }
    }
  }

  // No `tables` key — see the module comment; this is Path C's whole point.
  return { schema_name: "DoclingDocument", version: "1.0.0", texts, pages: pagesOut };
}
