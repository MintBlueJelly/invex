import { describe, expect, it } from "vitest";
import { extractLineItemsFromTable } from "../../../src/table/lineItems";
import { parseAmount } from "../../../src/parsing/amounts";
import type { ExtractedTable } from "../../../src/positioned/model";
import type { LineColumnKey } from "../../../src/template/types";
import { knownBug } from "../../../../../test-utils/knownBug";

// German-locale template: "," is decimal, matching a real vendor's pinned locale.
const parseNum = (s: string) => parseAmount(s, ",");

const FULL_COLS: Partial<Record<LineColumnKey, number>> = {
  position: 0,
  description: 1,
  quantity: 2,
  unitPrice: 3,
  lineTotal: 4,
};

function table(rows: string[][]): ExtractedTable {
  return { page: 1, bbox: [0, 0, 1, 1], headerCells: ["Pos", "Bezeichnung", "Menge", "Einzelpreis", "Gesamt"], rows };
}

describe("extractLineItemsFromTable — clean table", () => {
  it("extracts position, description, quantity, unitPrice, lineTotal for a 5-column German table", () => {
    const t = table([
      ["1", "Aktenvernichter", "2", "199,50", "399,00"],
      ["2", "Tonerset", "3", "89,90", "269,70"],
    ]);
    const items = extractLineItemsFromTable(t, FULL_COLS, "none", parseNum);
    expect(items).toEqual([
      { position: 1, description: "Aktenvernichter", quantity: "2", unit: null, unitPrice: "199.50", taxRate: null, lineTotal: "399.00" },
      { position: 2, description: "Tonerset", quantity: "3", unit: null, unitPrice: "89.90", taxRate: null, lineTotal: "269.70" },
    ]);
  });
});

describe("extractLineItemsFromTable — missing optional columns", () => {
  // Column data is still physically present in the row (index 2); only the
  // mapping omits it — this is what a template with fewer detected columns looks like.
  it("no quantity column: quantity is null, description and lineTotal still extracted", () => {
    const cols = { position: 0, description: 1, unitPrice: 3, lineTotal: 4 };
    const t = table([["1", "Aktenvernichter", "2", "199,50", "399,00"]]);
    const items = extractLineItemsFromTable(t, cols, "none", parseNum);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ description: "Aktenvernichter", quantity: null, unitPrice: "199.50", lineTotal: "399.00" });
  });

  it("no unitPrice column: unitPrice is null, description and lineTotal still extracted", () => {
    const cols = { position: 0, description: 1, quantity: 2, lineTotal: 4 };
    const t = table([["1", "Aktenvernichter", "2", "199,50", "399,00"]]);
    const items = extractLineItemsFromTable(t, cols, "none", parseNum);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ description: "Aktenvernichter", quantity: "2", unitPrice: null, lineTotal: "399.00" });
  });

  it("no taxRate column: taxRate is null even though the cell holds a rate", () => {
    // Row has a 6th cell (a real tax-rate percentage) that the mapping simply doesn't reference.
    const t = table([["1", "Aktenvernichter", "2", "199,50", "399,00", "19%"]]);
    const items = extractLineItemsFromTable(t, FULL_COLS, "none", parseNum);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ description: "Aktenvernichter", taxRate: null, lineTotal: "399.00" });
  });
});

describe("extractLineItemsFromTable — descriptionContinuation: rowsWithoutPosNumber", () => {
  it("merges a blank-position description-only row into the previous item's description", () => {
    const t = table([
      ["1", "Rechtsberatung", "1", "500,00", "500,00"],
      ["", "Fortsetzung des Textes", "", "", ""],
    ]);
    const items = extractLineItemsFromTable(t, FULL_COLS, "rowsWithoutPosNumber", parseNum);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      description: "Rechtsberatung Fortsetzung des Textes",
      quantity: "1",
      unitPrice: "500.00",
      lineTotal: "500.00",
    });
  });

  // No item exists yet to merge into. `isContinuation && items.length > 0` is false,
  // so the row falls through to the normal item-creation path instead of being
  // merged or dropped — it becomes its own item with position null. Not one of
  // the assigned known-bug ids; recorded here as current behaviour only.
  it("[current] a continuation-shaped row appearing before any item becomes its own item, not a merge target", () => {
    const t = table([
      ["", "Orphan continuation text", "", "", ""],
      ["1", "Widget", "2", "10,00", "20,00"],
    ]);
    const items = extractLineItemsFromTable(t, FULL_COLS, "rowsWithoutPosNumber", parseNum);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ position: null, description: "Orphan continuation text" });
    expect(items[1]).toMatchObject({ position: 1, description: "Widget" });
  });
});

describe("extractLineItemsFromTable — descriptionContinuation: none", () => {
  it("a continuation-shaped row becomes its own line item instead of merging", () => {
    const t = table([
      ["1", "Widget", "2", "10,00", "20,00"],
      ["", "Continuation text", "", "", ""],
    ]);
    const items = extractLineItemsFromTable(t, FULL_COLS, "none", parseNum);
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ position: null, description: "Continuation text", quantity: null });
  });
});

describe("extractLineItemsFromTable — taxRate cell formats", () => {
  // taxRate is the only float in the money path (Number(...) on parseNum's output),
  // so every rendering a vendor might use for "19%" must land on 19.
  it.each([
    ["19 %", 19],
    ["19%", 19],
    ["19", 19],
    ["19%%", 19], // two % signs: stripNoise in parseAmount strips both regardless of the explicit .replace("%","")
    ["19,5%", 19.5],
  ])("parses tax-rate cell %j as %j", (cellValue, expected) => {
    const cols = { ...FULL_COLS, taxRate: 5 };
    const t = table([["1", "Widget", "2", "10,00", "20,00", cellValue]]);
    const items = extractLineItemsFromTable(t, cols, "none", parseNum);
    expect(items[0]?.taxRate).toBe(expected);
  });
});

describe("extractLineItemsFromTable — ragged rows", () => {
  it("a row shorter than the header leaves the missing trailing fields null", () => {
    const t = table([["1", "Widget"]]); // no quantity/unitPrice/lineTotal cells at all
    const items = extractLineItemsFromTable(t, FULL_COLS, "none", parseNum);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ position: 1, description: "Widget", quantity: null, unitPrice: null, lineTotal: null });
  });

  it("a row with extra trailing cells beyond the mapped columns ignores the extras", () => {
    const t = table([["2", "Gadget", "3", "5,00", "15,00", "unused", "also unused"]]);
    const items = extractLineItemsFromTable(t, FULL_COLS, "none", parseNum);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ position: 2, description: "Gadget", quantity: "3", unitPrice: "5.00", lineTotal: "15.00" });
  });
});

describe("extractLineItemsFromTable — empty / whitespace rows", () => {
  it("fully empty and whitespace-only rows are dropped (no description, no amounts to lose)", () => {
    const t = table([
      ["", "", "", "", ""],
      ["   ", "  ", "\t", " ", " "],
      ["1", "Widget", "2", "10,00", "20,00"],
    ]);
    const items = extractLineItemsFromTable(t, FULL_COLS, "none", parseNum);
    expect(items).toHaveLength(1);
    expect(items[0]?.description).toBe("Widget");
  });
});

describe("extractLineItemsFromTable — unparseable amounts", () => {
  it("parseNum returning null (unparseable cell) yields a null field, not a throw", () => {
    const t = table([["1", "Widget", "abc", "not-money", "also-not-money"]]);
    const items = extractLineItemsFromTable(t, FULL_COLS, "none", parseNum);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ description: "Widget", quantity: null, unitPrice: null, lineTotal: null });
  });
});

describe("extractLineItemsFromTable — position parsing", () => {
  it.each([
    ["1", 1],
    ["01", 1], // Number("01") coerces the leading zero away
    ["1.", null], // trailing dot fails the full-string /^\d+$/ match — not treated as numeric
    ["a1", null],
    ["", null], // blank cell -> cell() returns null before the regex even runs
  ])("position cell %j -> %j", (posCell, expected) => {
    const t = table([[posCell, "Widget", "2", "10,00", "20,00"]]);
    const items = extractLineItemsFromTable(t, FULL_COLS, "none", parseNum);
    expect(items[0]?.position).toBe(expected);
  });
});

describe("extractLineItemsFromTable — known bugs", () => {
  it("[current] a row carrying amounts but no description is silently dropped", () => {
    const t = table([
      ["", "", "2", "10,00", "20,00"], // amount-bearing row, no description column value
      ["1", "Widget", "1", "5,00", "5,00"],
    ]);
    const items = extractLineItemsFromTable(t, FULL_COLS, "none", parseNum);
    expect(items).toHaveLength(1); // the 20,00 line vanished with no trace
    expect(items[0]?.description).toBe("Widget");
  });

  knownBug("INVEX-028", "rows with amounts but no description are dropped silently").it(
    "retains a row that carries amounts even when its description cell is blank",
    () => {
      const t = table([
        ["", "", "2", "10,00", "20,00"],
        ["1", "Widget", "1", "5,00", "5,00"],
      ]);
      const items = extractLineItemsFromTable(t, FULL_COLS, "none", parseNum);
      expect(items).toHaveLength(2);
    },
  );

  it("[current] descriptionContinuation: \"indentedRows\" behaves identically to \"none\" (unimplemented)", () => {
    const t = table([
      ["1", "Widget", "2", "10,00", "20,00"],
      ["", "  indented continuation fragment", "", "", ""],
    ]);
    const items = extractLineItemsFromTable(t, FULL_COLS, "indentedRows", parseNum);
    expect(items).toHaveLength(2); // the continuation fragment became its own item instead of merging
  });

  knownBug("INVEX-029", "indentedRows continuation is not implemented; behaves as none").it(
    "merges an indented continuation row into the previous item's description",
    () => {
      const t = table([
        ["1", "Widget", "2", "10,00", "20,00"],
        ["", "  indented continuation fragment", "", "", ""],
      ]);
      const items = extractLineItemsFromTable(t, FULL_COLS, "indentedRows", parseNum);
      expect(items).toHaveLength(1);
    },
  );

  it("[current] rowsWithoutPosNumber never merges when the template has no position column", () => {
    const cols = { description: 1, quantity: 2, unitPrice: 3, lineTotal: 4 }; // no `position` key at all
    const t = table([
      ["1", "Widget", "2", "10,00", "20,00"],
      ["", "continuation fragment", "", "", ""],
    ]);
    const items = extractLineItemsFromTable(t, cols, "rowsWithoutPosNumber", parseNum);
    expect(items).toHaveLength(2); // continuation merging is gated on columns.position being defined
  });

  knownBug(
    "INVEX-029",
    "continuation merging requires columns.position, so a position-less template can never merge",
  ).it("merges a continuation row even when the template has no position column", () => {
    const cols = { description: 1, quantity: 2, unitPrice: 3, lineTotal: 4 };
    const t = table([
      ["1", "Widget", "2", "10,00", "20,00"],
      ["", "continuation fragment", "", "", ""],
    ]);
    const items = extractLineItemsFromTable(t, cols, "rowsWithoutPosNumber", parseNum);
    expect(items).toHaveLength(1);
  });
});

describe("extractLineItemsFromTable — leading continuation row", () => {
  knownBug("INVEX-033", "a continuation-shaped row before any item becomes a phantom line item")
    .it("does not turn a leading continuation row into its own item", () => {
      // isContinuation is gated on items.length > 0, so a description-only row
      // arriving first falls through to normal item creation. A mis-detected
      // header row, or a table whose first real row was dropped by INVEX-028,
      // therefore materialises as a line item with no amounts — which then
      // participates in the line-sum constraint.
      const t = table([
        ["", "fortgesetzte Beschreibung", "", "", ""],
        ["1", "Aktenvernichter", "2", "199,50", "399,00"],
      ]);
      const items = extractLineItemsFromTable(
        t,
        { position: 0, description: 1, quantity: 2, unitPrice: 3, lineTotal: 4 },
        "rowsWithoutPosNumber",
        (s) => parseAmount(s, ","),
      );
      expect(items).toHaveLength(1);
    });
});
