import { eq, inArray, sql } from "drizzle-orm";
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

  if (existing) {
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
    const version = existing.row.version + 1;
    await db
      .update(vendorTemplates)
      .set({
        template: merged as unknown as Record<string, unknown>,
        version,
        source,
        ustIdNr: merged.vendorIds.ustIdNr ?? existing.row.ustIdNr,
        steuernummer: merged.vendorIds.steuernummer ?? existing.row.steuernummer,
        nameHash: merged.vendorIds.nameHash ?? existing.row.nameHash,
        updatedAt: sql`now()`,
      })
      .where(eq(vendorTemplates.id, existing.row.id));
    await linkIbans(db, existing.row.id, merged.vendorIds.ibans ?? []);
    return { id: existing.row.id, version, created: false };
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

async function linkIbans(db: DbOrTx, templateId: string, ibans: string[]): Promise<void> {
  for (const iban of ibans) {
    await db
      .insert(vendorTemplateIbans)
      .values({ iban, templateId })
      .onConflictDoUpdate({ target: vendorTemplateIbans.iban, set: { templateId } });
  }
}

export async function listTemplates(db: DbOrTx, limit: number): Promise<VendorTemplateRow[]> {
  return db.select().from(vendorTemplates).orderBy(vendorTemplates.updatedAt).limit(limit);
}

export async function getTemplate(db: DbOrTx, id: string): Promise<VendorTemplateRow | null> {
  const rows = await db.select().from(vendorTemplates).where(eq(vendorTemplates.id, id)).limit(1);
  return rows[0] ?? null;
}
