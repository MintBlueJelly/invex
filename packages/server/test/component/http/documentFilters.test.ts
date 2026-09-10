import { describe, expect, makeItShared } from "../../utils/fixture";
import { seedDocument } from "../../utils/testEnv";

const it = makeItShared();

/**
 * GET /api/documents — the document-class filters.
 *
 * The one that matters is arithmeticVerified. Once a Lieferschein that prints no
 * prices can reach "committed", that status alone no longer distinguishes "the
 * numbers check out" from "there were no numbers" — and a consumer with no way
 * to tell them apart will read the second as the first.
 */
describe("GET /api/documents — document-class filters", () => {
  const seedAll = async (db: Parameters<typeof seedDocument>[0]) => {
    await seedDocument(db, {
      filename: "invoice.pdf", status: "committed",
      documentType: "invoice", arithmeticVerified: true,
    });
    await seedDocument(db, {
      filename: "lieferschein.pdf", status: "committed",
      documentType: "deliveryNote", arithmeticVerified: false,
    });
    await seedDocument(db, {
      filename: "ab.pdf", status: "pending_review",
      documentType: "orderConfirmation", arithmeticVerified: false,
    });
    // Predates the flag: reconciled before the column existed.
    await seedDocument(db, { filename: "legacy.pdf", status: "committed", documentType: "invoice" });
  };

  type Row = { filename: string; documentType: string | null; arithmeticVerified: boolean | null };

  it("exposes documentType and arithmeticVerified on the summary", async ({ env }) => {
    await seedAll(env.db);
    const res = await env.app.inject({ method: "GET", url: "/api/documents?limit=50" });
    expect(res.statusCode).toBe(200);
    const invoice = (res.json() as Row[]).find((r) => r.filename === "invoice.pdf")!;
    expect(invoice.documentType).toBe("invoice");
    expect(invoice.arithmeticVerified).toBe(true);
  });

  it("filters by document class", async ({ env }) => {
    await seedAll(env.db);
    const res = await env.app.inject({ method: "GET", url: "/api/documents?documentType=deliveryNote" });
    expect((res.json() as Row[]).map((r) => r.filename)).toEqual(["lieferschein.pdf"]);
  });

  // The query the flag exists for.
  it("separates committed-and-checked from committed-with-nothing-to-check", async ({ env }) => {
    await seedAll(env.db);
    const get = async (q: string) =>
      ((await env.app.inject({ method: "GET", url: `/api/documents?${q}` })).json() as Row[]).map(
        (r) => r.filename,
      );

    expect(await get("status=committed&arithmeticVerified=true")).toEqual(["invoice.pdf"]);
    expect(await get("status=committed&arithmeticVerified=false")).toEqual(["lieferschein.pdf"]);
    // All three are "committed"; the status alone cannot tell them apart.
    expect(await get("status=committed")).toHaveLength(3);
  });

  it("leaves rows that predate the flag out of BOTH verified filters", async ({ env }) => {
    await seedAll(env.db);
    const get = async (q: string) =>
      ((await env.app.inject({ method: "GET", url: `/api/documents?${q}` })).json() as Row[]).map(
        (r) => r.filename,
      );
    const names = [...(await get("arithmeticVerified=true")), ...(await get("arithmeticVerified=false"))];
    expect(names).not.toContain("legacy.pdf");
  });

  it("rejects a documentType outside the five classes", async ({ env }) => {
    const res = await env.app.inject({ method: "GET", url: "/api/documents?documentType=reminder" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-boolean arithmeticVerified rather than coercing it", async ({ env }) => {
    const res = await env.app.inject({ method: "GET", url: "/api/documents?arithmeticVerified=yes" });
    expect(res.statusCode).toBe(400);
  });
});
