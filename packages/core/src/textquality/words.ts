/**
 * Compact German+English wordlist for the text-quality gate. NOT a full top-5k
 * frequency list: common function/business words plus invoice-domain vocabulary,
 * matched with compound-aware substring logic (German compounds hit via their
 * parts: "Wartungsvertrag" → "vertrag"). Garbage OCR output scores ≈ 0 against
 * this; real invoice/letter text scores well above the gate threshold.
 */
export const GATE_WORDS: readonly string[] = [
  // German function/common words
  "aber", "alle", "allem", "allen", "aller", "alles", "auch", "bei", "beim", "bereits",
  "bitte", "dann", "das", "dass", "dem", "den", "der", "des", "dessen", "dies", "diese",
  "diesem", "diesen", "dieser", "dieses", "doch", "durch", "eine", "einem", "einen",
  "einer", "eines", "erst", "folgende", "folgenden", "gegen", "gilt", "gelten", "haben",
  "hier", "ihre", "ihrem", "ihren", "ihrer", "innerhalb", "ist", "jede", "jedem", "jeden",
  "jeder", "kann", "kein", "keine", "können", "koennen", "mehr", "mit", "nach", "nicht",
  "noch", "nur", "ohne", "oder", "sein", "seine", "sich", "sie", "sind", "sowie", "ueber",
  "uber", "und", "unter", "vom", "von", "vor", "war", "weitere", "wenn", "werden", "wird",
  "wir", "wurde", "wurden", "zum", "zur", "zwischen",
  // German business/invoice vocabulary (compound parts)
  "abzug", "adresse", "akten", "angebot", "anzahl", "artikel", "aufstellung", "auftrag",
  "ausstellung", "bank", "bedingungen", "beleg", "bestell", "betrag", "bezeichnung",
  "brutto", "buro", "buero", "daten", "datum", "einzel", "empfanger", "empfaenger",
  "firma", "frist", "gerat", "geraet", "gerate", "geraete", "gesamt", "geschafts",
  "geschaefts", "gesellschaft", "gmbh", "gultig", "gueltig", "handel", "hiermit",
  "industrie", "kasse", "konto", "kunde", "kunden", "landes", "leistung", "leistungen",
  "liefer", "lieferung", "menge", "monat", "monate", "netto", "nummer", "position",
  "preis", "preise", "rabatt", "rechnung", "recht", "rechts", "satz", "seite", "service",
  "skonto", "steuer", "strasse", "stuck", "stueck", "summe", "technik", "termin", "toner",
  "verbindung", "vernichter", "versand", "vertrag", "wartung", "wert", "zahl", "zahlbar",
  "zahlung", "zeit", "zeitraum", "zwischen",
  // German cities (letterheads)
  "berlin", "hamburg", "munchen", "muenchen", "koln", "koeln", "frankfurt", "stuttgart",
  "dusseldorf", "duesseldorf", "leipzig", "dortmund", "essen", "bremen", "dresden",
  "hannover", "nurnberg", "nuernberg",
  // English function/common words
  "about", "after", "all", "amount", "and", "any", "are", "attached", "based", "been",
  "before", "being", "below", "between", "both", "business", "but", "can", "company",
  "conditions", "contact", "contract", "customer", "date", "days", "dear", "delivery",
  "description", "details", "due", "each", "email", "following", "for", "from", "further",
  "have", "hereby", "included", "information", "invoice", "item", "items", "law", "letter",
  "limited", "may", "month", "months", "net", "note", "number", "office", "only", "order",
  "other", "our", "page", "payable", "payment", "period", "please", "price", "product",
  "quantity", "rate", "reference", "regards", "sales", "service", "services", "shall",
  "sincerely", "subject", "such", "supply", "tax", "term", "terms", "than", "that", "the",
  "their", "them", "then", "there", "these", "this", "time", "total", "under", "unit",
  "until", "upon", "value", "was", "week", "will", "with", "within", "without", "you", "your",
];
