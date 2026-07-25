import { describe, expect, makeItShared } from "../../utils/fixture";
import { seedDocument } from "../../utils/testEnv";

/**
 * INVEX-008 — unvalidated path and query parameters.
 *
 * `:id` went straight into `eq(documents.id, id)` against a uuid column, so any
 * non-UUID produced a Postgres 22P02 that Fastify rendered as a 500 whose body
 * contains the failed SQL statement and its bound parameters. Wrong status code
 * and internals disclosure on the same request. `?limit=abc` became
 * `Number("abc")` = NaN, which reached `.limit(NaN)` and 500'd the same way.
 */

const it = makeItShared();

const NOT_A_UUID = "not-a-uuid";
const ABSENT = "00000000-0000-4000-8000-000000000000";

describe("path parameter validation", () => {
  const routes = (id: string) => [
    `/api/documents/${id}`,
    `/api/documents/${id}/pdf`,
    `/api/documents/${id}/markdown`,
    `/api/documents/${id}/trace`,
    `/api/templates/${id}`,
    `/api/review/${id}`,
  ];

  for (const path of routes(NOT_A_UUID)) {
    it(`400s on a malformed id: ${path}`, async ({ env }) => {
      const res = await env.app.inject({ method: "GET", url: path });
      expect(res.statusCode).toBe(400);
      // The body must not carry the query that failed.
      expect(res.body).not.toMatch(/select|from "?documents/i);
    });
  }

  for (const path of routes(ABSENT)) {
    it(`404s on a well-formed but unknown id: ${path}`, async ({ env }) => {
      const res = await env.app.inject({ method: "GET", url: path });
      expect(res.statusCode).toBe(404);
    });
  }

  it("400s on a malformed id for PUT /api/review/:id", async ({ env }) => {
    const res = await env.app.inject({ method: "PUT", url: `/api/review/${NOT_A_UUID}`, payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe("query parameter validation", () => {
  it("rejects a non-numeric limit on /api/templates instead of 500ing", async ({ env }) => {
    const res = await env.app.inject({ method: "GET", url: "/api/templates?limit=abc" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-numeric limit on /api/escalations", async ({ env }) => {
    const res = await env.app.inject({ method: "GET", url: "/api/escalations?limit=abc" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a malformed documentId filter on /api/escalations", async ({ env }) => {
    const res = await env.app.inject({ method: "GET", url: `/api/escalations?documentId=${NOT_A_UUID}` });
    expect(res.statusCode).toBe(400);
  });

  it("still accepts valid limits", async ({ env }) => {
    for (const url of ["/api/templates?limit=5", "/api/escalations?limit=5", "/api/templates", "/api/escalations"]) {
      expect((await env.app.inject({ method: "GET", url })).statusCode, url).toBe(200);
    }
  });

  it("returns an empty list for an unknown but well-formed documentId", async ({ env }) => {
    const res = await env.app.inject({ method: "GET", url: `/api/escalations?documentId=${ABSENT}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("does not break the documents list query", async ({ env }) => {
    await seedDocument(env.db, { filename: "a.pdf", status: "committed" });
    const res = await env.app.inject({ method: "GET", url: "/api/documents?status=committed&limit=10" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });
});
