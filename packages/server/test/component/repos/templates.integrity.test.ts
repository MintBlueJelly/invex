import type { VendorTemplate } from "@invex/core";
import { upsertTemplate, resolveVendor, listTemplates } from "../../../src/db/repos/templates";
import { describe, expect, makeItShared } from "../../utils/fixture";

/**
 * INVEX-011 — vendor template repository integrity.
 *
 * Three separate defects, all in the store that the entire feedback loop
 * depends on:
 *   - `version` was computed in application code (existing.version + 1), a
 *     read-modify-write with no locking.
 *   - `listTemplates` sorted ASCENDING by updatedAt, so the endpoint returned
 *     the 100 OLDEST templates and never the ones just learned — the exact
 *     opposite of what you want when checking whether learning is working.
 *   - `linkIbans` silently reassigned an IBAN already claimed by another
 *     vendor, so a shared payment-provider IBAN or a mis-OCR'd one flipped the
 *     mapping and resolveVendor then drove extraction with the wrong template.
 */

const it = makeItShared();

function template(patch: Partial<VendorTemplate["vendorIds"]> = {}): VendorTemplate {
  return {
    templateVersion: 1,
    vendorIds: { displayName: "ACME GmbH", nameHash: "acme-hash", ...patch },
    locale: { decimal: ",", dateFormats: ["dd.MM.yyyy"] },
    fields: {},
  };
}

describe("upsertTemplate versioning", () => {
  it("increments the version on each update", async ({ env }) => {
    const a = await upsertTemplate(env.db, template({ ustIdNr: "DE811907980" }), "rule_engine");
    expect(a).toMatchObject({ version: 1, created: true });

    const b = await upsertTemplate(env.db, template({ ustIdNr: "DE811907980" }), "vlm");
    expect(b).toMatchObject({ id: a.id, version: 2, created: false });

    const c = await upsertTemplate(env.db, template({ ustIdNr: "DE811907980" }), "human_review");
    expect(c).toMatchObject({ id: a.id, version: 3, created: false });
  });

  it("reports the version the database actually stored", async ({ env }) => {
    // The returned version must come from the UPDATE's RETURNING clause, not
    // from a number the application computed before writing. Anything else is a
    // read-modify-write that reports a version it did not necessarily win.
    const a = await upsertTemplate(env.db, template({ ustIdNr: "DE811907980" }), "rule_engine");
    const b = await upsertTemplate(env.db, template({ ustIdNr: "DE811907980" }), "vlm");

    const stored = (await listTemplates(env.db, 10)).find((t) => t.id === a.id);
    expect(stored!.version).toBe(b.version);
  });
});

describe("listTemplates ordering", () => {
  it("returns the most recently updated first", async ({ env }) => {
    const first = await upsertTemplate(env.db, template({ ustIdNr: "DE811907980", nameHash: "a" }), "rule_engine");
    const second = await upsertTemplate(env.db, template({ ustIdNr: "DE136695976", nameHash: "b" }), "vlm");

    const rows = await listTemplates(env.db, 10);
    expect(rows.map((r) => r.id)).toEqual([second.id, first.id]);
  });

  it("surfaces a freshly learned template at the top", async ({ env }) => {
    // The operational question this endpoint exists to answer is "is the
    // feedback loop producing templates?". Oldest-first answered it with the
    // templates least likely to be relevant.
    await upsertTemplate(env.db, template({ ustIdNr: "DE811907980", nameHash: "a" }), "rule_engine");
    const learned = await upsertTemplate(env.db, template({ ustIdNr: "DE136695976", nameHash: "b" }), "human_review");

    const rows = await listTemplates(env.db, 10);
    expect(rows[0]!.id).toBe(learned.id);
    expect(rows[0]!.source).toBe("human_review");
  });
});

describe("linkIbans ownership", () => {
  it("resolves a vendor by its own IBAN", async ({ env }) => {
    const t = await upsertTemplate(
      env.db,
      template({ ustIdNr: "DE811907980", ibans: ["DE02120300000000202051"] }),
      "rule_engine",
    );
    const found = await resolveVendor(env.db, {
      ustIdNr: null,
      steuernummer: null,
      ibans: ["DE02120300000000202051"],
      nameHash: null,
    });
    expect(found).toMatchObject({ matchedBy: "iban" });
    expect(found!.row.id).toBe(t.id);
  });

  it("keeps two vendors sharing an IBAN as separate templates", async ({ env }) => {
    // A shared payment-service-provider IBAN, or a mis-OCR'd one. resolveVendor
    // falls through ustIdNr -> steuernummer -> iban, so a NON-matching USt-IdNr
    // did not stop the IBAN from matching: both vendors resolved to one row and
    // the second overwrote the first's identity outright.
    const owner = await upsertTemplate(
      env.db,
      template({ ustIdNr: "DE811907980", nameHash: "owner", ibans: ["DE02120300000000202051"] }),
      "rule_engine",
    );
    const other = await upsertTemplate(
      env.db,
      template({ ustIdNr: "DE136695976", nameHash: "other", ibans: ["DE02120300000000202051"] }),
      "vlm",
    );

    expect(other.created).toBe(true);
    expect(other.id).not.toBe(owner.id);
    expect(await listTemplates(env.db, 10)).toHaveLength(2);
  });

  it("does not let the second vendor overwrite the first's identity", async ({ env }) => {
    const owner = await upsertTemplate(
      env.db,
      template({ ustIdNr: "DE811907980", nameHash: "owner", ibans: ["DE02120300000000202051"] }),
      "rule_engine",
    );
    await upsertTemplate(
      env.db,
      template({ ustIdNr: "DE136695976", nameHash: "other", ibans: ["DE02120300000000202051"] }),
      "vlm",
    );

    const stored = (await listTemplates(env.db, 10)).find((t) => t.id === owner.id);
    expect(stored?.ustIdNr).toBe("DE811907980");
    expect(stored?.nameHash).toBe("owner");
  });

  it("keeps the shared IBAN pointing at whoever claimed it first", async ({ env }) => {
    const owner = await upsertTemplate(
      env.db,
      template({ ustIdNr: "DE811907980", nameHash: "owner", ibans: ["DE02120300000000202051"] }),
      "rule_engine",
    );
    await upsertTemplate(
      env.db,
      template({ ustIdNr: "DE136695976", nameHash: "other", ibans: ["DE02120300000000202051"] }),
      "vlm",
    );

    const found = await resolveVendor(env.db, {
      ustIdNr: null,
      steuernummer: null,
      ibans: ["DE02120300000000202051"],
      nameHash: null,
    });
    expect(found!.row.id).toBe(owner.id);
  });

  it("still resolves each vendor by its own USt-IdNr", async ({ env }) => {
    await upsertTemplate(env.db, template({ ustIdNr: "DE811907980", nameHash: "owner", ibans: ["DE02120300000000202051"] }), "rule_engine");
    await upsertTemplate(env.db, template({ ustIdNr: "DE136695976", nameHash: "other", ibans: ["DE02120300000000202051"] }), "vlm");

    for (const id of ["DE811907980", "DE136695976"]) {
      const found = await resolveVendor(env.db, { ustIdNr: id, steuernummer: null, ibans: null, nameHash: null });
      expect(found?.matchedBy, id).toBe("ustIdNr");
      expect(found?.row.ustIdNr, id).toBe(id);
    }
  });

  it("still lets a vendor keep its own IBAN across its own updates", async ({ env }) => {
    const t = await upsertTemplate(
      env.db,
      template({ ustIdNr: "DE811907980", ibans: ["DE02120300000000202051"] }),
      "rule_engine",
    );
    await upsertTemplate(
      env.db,
      template({ ustIdNr: "DE811907980", ibans: ["DE02120300000000202051", "DE89370400440532013000"] }),
      "human_review",
    );

    for (const iban of ["DE02120300000000202051", "DE89370400440532013000"]) {
      const found = await resolveVendor(env.db, { ustIdNr: null, steuernummer: null, ibans: [iban], nameHash: null });
      expect(found!.row.id, iban).toBe(t.id);
    }
  });
});
