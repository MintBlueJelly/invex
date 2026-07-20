import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  computeInvoice,
  makeGarbageTextPdf,
  makeLetterPdf,
  makeMalformedZugferdPdf,
  makeScannedPdf,
  makeTextInvoicePdf,
  makeZugferdPdf,
  sampleSpec,
} from "../index";

/**
 * Writes the standard fixture set + expected.json (the smoke harness assertion
 * manifest) to the target folder. Usage: pnpm fixtures [outDir]
 */
// pnpm runs scripts in the package dir; INIT_CWD is where the user invoked.
const outDir = resolve(process.env["INIT_CWD"] ?? process.cwd(), process.argv[2] ?? "./out");
await mkdir(outDir, { recursive: true });

const spec = sampleSpec();
const inv = computeInvoice(spec);

const files: Record<string, Uint8Array> = {
  "zugferd-ok.pdf": await makeZugferdPdf(spec),
  "zugferd-malformed.pdf": await makeMalformedZugferdPdf(spec),
  "text-invoice.pdf": await makeTextInvoicePdf(spec),
  // Labels deliberately OUTSIDE the rule-engine lexicon → forces escalation.
  "text-invoice-unknown-labels.pdf": await makeTextInvoicePdf(spec, {
    labels: {
      invoiceNumber: "Vorgangskennung",
      invoiceDate: "Erstellt",
      subtotal: "Basiswert",
      vat: "Abgabe",
      total: "Absolutwert",
      tableHeaders: ["Zeile", "Text", "Vol", "Kurs", "Absolut"],
    },
  }),
  "letter.pdf": await makeLetterPdf("Allgemeine Geschäftsbedingungen", [
    "Die nachfolgenden Bedingungen gelten für alle Lieferungen und Leistungen der ACME Bürotechnik GmbH.",
    "Angebote sind freibleibend. Lieferfristen sind nur verbindlich, wenn sie schriftlich bestätigt wurden.",
    "Es gilt deutsches Recht unter Ausschluss des UN-Kaufrechts. Gerichtsstand ist München.",
  ]),
  "garbage-text.pdf": await makeGarbageTextPdf(),
  "scanned.pdf": await makeScannedPdf(spec),
};

for (const [name, bytes] of Object.entries(files)) {
  await writeFile(join(outDir, name), bytes);
}

/** Expected-outcome matrix (plan §Testing): consumed by `pnpm smoke --expect`. */
const expected = {
  "zugferd-ok.pdf": {
    route: "zugferd",
    terminalStatus: "committed",
    gross: inv.totals.gross,
    lineCount: inv.lines.length,
  },
  "zugferd-malformed.pdf": {
    hasEvents: ["xml_fallthrough"],
  },
  "text-invoice.pdf": {
    route: "text",
    terminalStatus: "committed",
    gross: inv.totals.gross,
    lineCount: inv.lines.length,
  },
  "text-invoice-unknown-labels.pdf": {
    route: "text",
  },
  "letter.pdf": {
    route: "text",
    terminalStatus: "exported_markdown",
  },
  "garbage-text.pdf": {
    hasEvents: ["text_gate"],
  },
  "scanned.pdf": {
    route: "image",
  },
};
await writeFile(join(outDir, "expected.json"), JSON.stringify(expected, null, 2));

console.log(`wrote ${Object.keys(files).length} fixtures + expected.json to ${outDir}`);
