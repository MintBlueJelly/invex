import { desc, eq, inArray, sql } from "drizzle-orm";
import type { VendorTemplate } from "@invex/core";
import type { DbOrTx } from "./documents";
import { vendorTemplateIbans, vendorTemplates, type TemplateSource } from "../schema";

export type VendorTemplateRow = typeof vendorTemplates.$inferSelect;

export interface VendorLookup {
  ustIdNr?: string | null;
  steuernummer?: string | null;
  ibans?: string[] | null;
  nameHash?: string | null;
}

export interface ResolvedVendor {
  row: VendorTemplateRow;
  template: VendorTemplate;
  /** Which identifier resolved the vendor — logged in the trace. */
  matchedBy: "ustIdNr" | "steuernummer" | "iban" | "nameHash";
}

/**
 * Composite vendor-ID resolution, priority order per briefing §3:
 * USt-IdNr (checksum-verified upstream) → Steuernummer → IBAN → name+PLZ hash.
 * Callers pass only identifiers they trust (checksums already applied).
 */
export async function resolveVendor(db: DbOrTx, lookup: VendorLookup): Promise<ResolvedVendor | null> {
  if (lookup.ustIdNr) {
    const rows = await db.select().from(vendorTemplates).where(eq(vendorTemplates.ustIdNr, lookup.ustIdNr)).limit(1);
    if (rows[0]) return { row: rows[0], template: rows[0].template as unknown as VendorTemplate, matchedBy: "ustIdNr" };
  }
  if (lookup.steuernummer) {
    const rows = await db
      .select()
      .from(vendorTemplates)
      .where(eq(vendorTemplates.steuernummer, lookup.steuernummer))
      .limit(1);
    if (rows[0]) return { row: rows[0], template: rows[0].template as unknown as VendorTemplate, matchedBy: "steuernummer" };
  }
  if (lookup.ibans && lookup.ibans.length > 0) {
    const links = await db
      .select()
      .from(vendorTemplateIbans)
      .where(inArray(vendorTemplateIbans.iban, lookup.ibans))
      .limit(1);
    if (links[0]) {
      const rows = await db
        .select()
        .from(vendorTemplates)
        .where(eq(vendorTemplates.id, links[0].templateId))
        .limit(1);
      if (rows[0]) return { row: rows[0], template: rows[0].template as unknown as VendorTemplate, matchedBy: "iban" };
    }
  }
  if (lookup.nameHash) {
    const rows = await db
      .select()
      .from(vendorTemplates)
      .where(eq(vendorTemplates.nameHash, lookup.nameHash))
      .limit(1);
    if (rows[0]) return { row: rows[0], template: rows[0].template as unknown as VendorTemplate, matchedBy: "nameHash" };
  }
  return null;
}

/**
 * Create or update the vendor's template. ALL observed identifiers are written
 * (any one resolves the vendor later); an update bumps the version and merges
 * newly observed IBANs.
 */
export async function upsertTemplate(
  db: DbOrTx,
  template: VendorTemplate,
  source: TemplateSource,
): Promise<{ id: string; version: number; created: boolean }> {
  const ids = template.vendorIds;
  const existing = await resolveVendor(db, {
    ustIdNr: ids.ustIdNr ?? null,
    steuernummer: ids.steuernummer ?? null,
    ibans: ids.ibans ?? null,
    nameHash: ids.nameHash ?? null,
  });

  // A NON-matching strong identifier is decisive evidence of a different vendor.
  // resolveVendor falls through ustIdNr -> steuernummer -> iban -> nameHash, which
  // is the right LOOKUP order but the wrong merge rule: two vendors sharing a
  // payment-provider IBAN (or one mis-OCR'd IBAN) both resolved to the same row,
  // and the second overwrote the first's ustIdNr and nameHash outright — erasing
  // a checksum-verified identity on the strength of a weaker match (INVEX-011).
  const conflicts =
    existing !== null &&
    existing.matchedBy !== "ustIdNr" &&
    existing.matchedBy !== "steuernummer" &&
    ((ids.ustIdNr && existing.row.ustIdNr && ids.ustIdNr !== existing.row.ustIdNr) ||
      (ids.steuernummer && existing.row.steuernummer && ids.steuernummer !== existing.row.steuernummer));

  if (existing && !conflicts) {
    const merged: VendorTemplate = {
      ...template,
      vendorIds: {
        ...existing.template.vendorIds,
        ...Object.fromEntries(Object.entries(ids).filter(([, v]) => v !== undefined && v !== null)),
        ibans: [
          ...new Set([...(existing.template.vendorIds.ibans ?? []), ...(ids.ibans ?? [])]),
        ],
      },
    };
    // version = version + 1 in SQL, and the stored value is read back from
    // RETURNING. Computing it in application code is a read-modify-write: two
    // concurrent commits for the same vendor both read v3, both write v4, and
    // one template's field set is silently lost.
    const updated = await db
      .update(vendorTemplates)
      .set({
        template: merged as unknown as Record<string, unknown>,
        version: sql`${vendorTemplates.version} + 1`,
        source,
        ustIdNr: merged.vendorIds.ustIdNr ?? existing.row.ustIdNr,
        steuernummer: merged.vendorIds.steuernummer ?? existing.row.steuernummer,
        nameHash: merged.vendorIds.nameHash ?? existing.row.nameHash,
        updatedAt: sql`now()`,
      })
      .where(eq(vendorTemplates.id, existing.row.id))
      .returning({ version: vendorTemplates.version });
    await linkIbans(db, existing.row.id, merged.vendorIds.ibans ?? []);
    return { id: existing.row.id, version: updated[0]!.version, created: false };
  }

  const rows = await db
    .insert(vendorTemplates)
    .values({
      ustIdNr: ids.ustIdNr ?? null,
      steuernummer: ids.steuernummer ?? null,
      nameHash: ids.nameHash ?? null,
      template: template as unknown as Record<string, unknown>,
      source,
    })
    .returning();
  const row = rows[0]!;
  await linkIbans(db, row.id, ids.ibans ?? []);
  return { id: row.id, version: row.version, created: true };
}

/**
 * Claim IBANs for a template, first claim wins.
 *
 * This used to onConflictDoUpdate, silently reassigning an IBAN already held by
 * another vendor. Payment-service-provider IBANs are shared by many merchants
 * and OCR mis-reads happen, so the mapping flipped on every commit and
 * resolveVendor then drove deterministic extraction with the wrong vendor's
 * field anchors — with nothing logged (INVEX-011).
 */
async function linkIbans(db: DbOrTx, templateId: string, ibans: string[]): Promise<void> {
  for (const iban of ibans) {
    await db
      .insert(vendorTemplateIbans)
      .values({ iban, templateId })
      .onConflictDoNothing({ target: vendorTemplateIbans.iban });
  }
}

export async function listTemplates(db: DbOrTx, limit: number): Promise<VendorTemplateRow[]> {
  // desc: a bare column defaults to ASC in drizzle, so this returned the OLDEST
  // templates and never the ones just learned — the opposite of what the
  // endpoint exists to show. Every other list endpoint is newest-first.
  return db.select().from(vendorTemplates).orderBy(desc(vendorTemplates.updatedAt)).limit(limit);
}

export async function getTemplate(db: DbOrTx, id: string): Promise<VendorTemplateRow | null> {
  const rows = await db.select().from(vendorTemplates).where(eq(vendorTemplates.id, id)).limit(1);
  return rows[0] ?? null;
}
