import type { PositionedTextDocument } from "@invex/core";

/**
 * Text-quality gate corpus — prose, deliberately NOT a golden.
 *
 * INVEX-047 was a calibration failure, and the thing that caused it was the
 * corpus: the gate's 0.55 dictionary threshold was tuned against synthetic
 * pages of 18-43 words assembled out of the gate's own word list, which can
 * only ever agree with itself. Real pages are 250+ words of letterhead, proper
 * nouns, product vocabulary and ordinary German the list does not carry, and
 * they scored 0.33-0.48 against that threshold — legible documents, rerouted to
 * OCR.
 *
 * So these samples are not goldens and carry no `expected.canonical`: there is
 * nothing here to extract. They are pages as they read, paired with the one
 * verdict the gate owes them. Every party, address, person and identifier is
 * invented; the SHAPES are real — a two-column letterhead footer, a packaging
 * spec block, terms-and-conditions prose, a salutation.
 *
 * The garbage half is derived from the legible half by a literal, documented
 * corruption (`shiftEncoding`) rather than hand-typed junk. That pairing is the
 * point: the same words, the same page, one broken text layer — which is
 * exactly the input the gate exists to catch, and the only difference the gate
 * is allowed to react to.
 */

export interface GateSample {
  id: string;
  /** The verdict the gate owes this page. */
  expect: "legible" | "garbage";
  /** The real-world shape this sample stands for. */
  shape: string;
  lines: string[];
}

/**
 * Every Latin letter shifted three places — the signature of a PDF whose
 * ToUnicode table is missing or wrong, and of OCR decoded against the wrong
 * code page. Word lengths, spacing and punctuation survive; only the letters
 * stop being letters, which is why a shape check catches it and a word list
 * does not.
 */
export function shiftEncoding(text: string): string {
  return text.replace(/[a-zA-Z]/g, (ch) => {
    const base = ch <= "Z" ? 65 : 97;
    return String.fromCharCode(((ch.charCodeAt(0) - base + 3) % 26) + base);
  });
}

const LETTERHEAD_FOOTER = [
  "Telefon: +49 (0)8441 55 12 - 0    Kartonwerk Ammertal GmbH + Co. KG",
  "Telefax: +49 (0)8441 55 12 - 260    Talstraße 7 | 85276 Pfaffenhofen | HRA 100234 AG München",
  "Internet: www.kartonwerk-ammertal.example    Geschäftsführer: Peter Sommer, Julia Frank",
  "USt-Id-Nr.: DE123456789 / Steuer-Nr.: 40/210/00981    Komplementärin:",
  "Sparkasse Ammertal    Kartonwerk Ammertal Management GmbH, Sitz Pfaffenhofen",
  "IBAN: DE21 7005 1234 0000 1234 56    HRB 104877 AG München",
  "SWIFT/BIC: BYLADEM1ABC    Member of Ammertal",
];

const ORDER_CONFIRMATION_PROSE = [
  "Sehr geehrte Frau Wagner,",
  "wir danken Ihnen für Ihre Bestellung und bestätigen wie folgt:",
  "Klischees und Werkzeuge werden wir kostenlos einer Entsorgung zuführen, falls über einen Zeitraum von",
  "15 Monaten kein Auftrag gefertigt wurde.",
  "Aufgrund der anhaltenden und teilweise kurzfristig auftretenden Lieferengpässe bei Rohmaterialien sind derzeit",
  "sämtliche genannten Liefertermine unverbindlich. Im Einzelfall kann daraus eine längere Terminabweichung",
  "entstehen. Es bleibt jedoch weiterhin unser Ziel, den bestätigten Liefertermin zu erfüllen.",
  "Dieser Auftragsbestätigung liegen unsere aktuellen Rohstoffnotierungen zugrunde. Wir behalten uns eine",
  "Preisanpassung vor, sollten sich bis zur Lieferung die Kosten signifikant erhöhen.",
  "Mit freundlichen Grüßen",
  "Dieses Schreiben wurde elektronisch erstellt und ist auch ohne Unterschrift gültig.",
];

const PRODUCT_SPEC_BLOCK = [
  "Position: 1    5.200    1000 Stück    510,00 €    per",
  "Artikel-Nr.: 244516    Ihre Artikel-Nr.: 5379752-003",
  "Konstruktion: FEFCO 0204    FK m. mittig stoßenden Innen- und Außenklappen",
  "Abmessungen: 380 x 360 x 280 mm    Sorte: ET 26210 braun / braun",
  "Verschluss: Gluen    Druck: 1 Farbe Flexo / 15 % Standard",
  "Palettierung: 260 Stück pro Palette    Pal.-Abmessung: 1200 x 800 x 1900",
  "Artikelstückgewicht: 0,523 kg    Liefertermin: 5.200 Stück    29.01.2026",
];

const ENGLISH_DELIVERY_PROSE = [
  "Dear Ms Wagner,",
  "Please find enclosed the goods listed below, delivered under our framework agreement.",
  "Any shortage or transport damage must be reported in writing within seven working days of receipt.",
  "Title to the goods passes on receipt; risk passes when the consignment leaves our premises.",
  "This delivery note is issued electronically and is valid without a signature.",
];

export const GATE_SAMPLES: readonly GateSample[] = [
  {
    id: "de-letterhead-footer",
    expect: "legible",
    shape: "two-column German letterhead footer — bank details, register entries, proper nouns",
    lines: LETTERHEAD_FOOTER,
  },
  {
    id: "de-order-confirmation-prose",
    expect: "legible",
    shape: "salutation plus terms paragraphs from an Auftragsbestätigung",
    lines: ORDER_CONFIRMATION_PROSE,
  },
  {
    id: "de-product-spec-block",
    expect: "legible",
    shape: "packaging line-item spec block — labels, codes, dimensions, almost no prose",
    lines: PRODUCT_SPEC_BLOCK,
  },
  {
    id: "de-full-page",
    expect: "legible",
    shape: "a whole order-confirmation page: spec block, prose and footer together",
    lines: [...PRODUCT_SPEC_BLOCK, ...ORDER_CONFIRMATION_PROSE, ...LETTERHEAD_FOOTER],
  },
  {
    id: "en-delivery-note-prose",
    expect: "legible",
    shape: "English delivery-note body — the dictionary is bilingual, the gate must be too",
    lines: ENGLISH_DELIVERY_PROSE,
  },
  {
    id: "de-full-page-broken-cmap",
    expect: "garbage",
    shape: "the de-full-page sample with a broken ToUnicode table — same words, unreadable",
    lines: [...PRODUCT_SPEC_BLOCK, ...ORDER_CONFIRMATION_PROSE, ...LETTERHEAD_FOOTER].map(
      shiftEncoding,
    ),
  },
  {
    id: "de-prose-broken-cmap",
    expect: "garbage",
    shape: "prose alone with a broken ToUnicode table — no letterhead noise to blame",
    lines: ORDER_CONFIRMATION_PROSE.map(shiftEncoding),
  },
  {
    id: "cid-fallback",
    expect: "garbage",
    shape: "Docling falling back to raw glyph ids on an embedded-font page",
    lines: [...ORDER_CONFIRMATION_PROSE.slice(0, 3), "(cid:12) (cid:34) (cid:56) (cid:78)"],
  },
];

/**
 * A minimal positioned document for a sample: lines stacked down one page, each
 * a single token, which is the shape `mapDoclingDocument` produces on Path B.
 */
export function gateSampleDoc(sample: GateSample): PositionedTextDocument {
  return {
    pageCount: 1,
    lines: sample.lines.map((text, i) => {
      const y = 0.06 + i * 0.03;
      const bbox: [number, number, number, number] = [0.05, y, 0.95, y + 0.02];
      return { text, page: 1, bbox, tokens: [{ text, page: 1, bbox }] };
    }),
    tables: [],
  };
}
