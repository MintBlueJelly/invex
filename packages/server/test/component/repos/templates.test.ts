import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VendorTemplate } from "@invex/core";
import { createTestDb } from "../../utils/testEnv";
import type { Db } from "../../../src/db/client";
import { resolveVendor, upsertTemplate } from "../../../src/db/repos/templates";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => close());

function template(ids: VendorTemplate["vendorIds"]): VendorTemplate {
  return {
    templateVersion: 1,
    vendorIds: ids,
    locale: { decimal: ",", dateFormats: ["dd.MM.yyyy"] },
    fields: { invoiceNumber: { label: "Rechnungs-Nr." } },
  };
}

describe("vendor template store", () => {
  it("upserts and resolves by every identifier, priority order first", async () => {
    const created = await upsertTemplate(
      db,
      template({
        ustIdNr: "DE811907980",
        ibans: ["DE02120300000000202051"],
        nameHash: "abc12345",
        displayName: "ACME",
      }),
      "vlm",
    );
    expect(created.created).toBe(true);
    expect(created.version).toBe(1);

    const byUst = await resolveVendor(db, { ustIdNr: "DE811907980" });
    expect(byUst?.matchedBy).toBe("ustIdNr");
    const byIban = await resolveVendor(db, { ibans: ["DE02120300000000202051"] });
    expect(byIban?.matchedBy).toBe("iban");
    expect(byIban?.row.id).toBe(created.id);
    const byName = await resolveVendor(db, { nameHash: "abc12345" });
    expect(byName?.matchedBy).toBe("nameHash");
    expect(await resolveVendor(db, { ustIdNr: "DE136695976" })).toBeNull();

    // USt-IdNr outranks IBAN when both are present.
    const both = await resolveVendor(db, {
      ustIdNr: "DE811907980",
      ibans: ["DE02120300000000202051"],
    });
    expect(both?.matchedBy).toBe("ustIdNr");
  });

  it("updates bump the version and merge newly observed IBANs", async () => {
    const updated = await upsertTemplate(
      db,
      template({
        ustIdNr: "DE811907980",
        ibans: ["DE89370400440532013000"], // vendor switched banks / second account
        displayName: "ACME",
      }),
      "human_review",
    );
    expect(updated.created).toBe(false);
    expect(updated.version).toBe(2);

    // Both the old and the new IBAN resolve the same vendor (§3: store ALL ids).
    const oldIban = await resolveVendor(db, { ibans: ["DE02120300000000202051"] });
    const newIban = await resolveVendor(db, { ibans: ["DE89370400440532013000"] });
    expect(oldIban?.row.id).toBe(updated.id);
    expect(newIban?.row.id).toBe(updated.id);
    expect(newIban?.row.source).toBe("human_review");
  });
});
