import type { DecimalSeparator } from "../parsing/amounts";

/**
 * Vendor template descriptors (briefing §3): one canonical schema for all
 * vendors — templates map canonical fields to vendor-specific extraction
 * descriptors, never vendor-specific schemas. Descriptors combine multiple
 * anchor types because verbatim labels alone are insufficient.
 */

/**
 * Template vocabulary, NOT canonical field names.
 *
 * These name what a vendor-layout descriptor targets. They deliberately did not
 * follow the canonical schema's v2 rename (invoiceNumber -> documentNumber):
 * templates are persisted as jsonb, carry their own templateVersion, and are
 * already only a partial, non-isomorphic map of canonical paths. Keeping the
 * two vocabularies decoupled is what lets either evolve without migrating the
 * other. The mapping to canonical paths lives in template/apply.ts setField.
 */
export type TemplateFieldKey =
  | "invoiceNumber"
  | "issueDate"
  | "dueDate"
  | "totals.net"
  | "totals.tax"
  | "totals.gross";

export interface RegionAnchor {
  /** 1-based; -1 = last page. */
  page: number;
  /** Normalized [x0, y0, x1, y1], origin top-left. */
  bbox: [number, number, number, number];
}

export interface FieldDescriptor {
  label?: string;
  /** Regex source matched against candidate text. */
  valuePattern?: string;
  region?: RegionAnchor;
}

export type LineColumnKey =
  | "position"
  | "description"
  | "quantity"
  | "unit"
  | "unitPrice"
  | "taxRate"
  | "lineTotal";

export interface LineItemTableDescriptor {
  /** Disambiguates the correct table when a page contains several. */
  headerSignature: string[];
  /** Column mapping BY INDEX after table match — robust vs. per-cell labels. */
  columns: Partial<Record<LineColumnKey, number>>;
  /** Multi-row descriptions — the most common line-item failure mode. */
  descriptionContinuation: "rowsWithoutPosNumber" | "indentedRows" | "none";
}

export interface VendorTemplate {
  templateVersion: 1;
  vendorIds: {
    ustIdNr?: string;
    steuernummer?: string;
    ibans?: string[];
    nameHash?: string;
    displayName?: string;
  };
  locale: {
    decimal: DecimalSeparator;
    dateFormats: string[];
  };
  fields: Partial<Record<TemplateFieldKey, FieldDescriptor>>;
  lineItemTable?: LineItemTableDescriptor;
}
