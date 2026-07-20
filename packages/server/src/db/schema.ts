import {
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  CanonicalInvoice,
  ExtractionEnvelope,
  ReconciliationResult,
} from "@invex/core";

const bytea = customType<{ data: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

export type DocumentStatus =
  | "received"
  | "routed"
  | "extracted"
  | "escalated_vlm"
  | "pending_review"
  | "committed"
  | "exported_markdown"
  | "segmented"
  | "failed";

export type LaneRoute = "zugferd" | "text" | "image";

/** One row per logical document; the id is the end-to-end UUID (briefing §8). */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Set for child documents spawned by page segmentation. */
    parentId: uuid("parent_id"),
    filename: text("filename").notNull(),
    /** sha256 of the PDF bytes — idempotent re-ingest. */
    contentHash: text("content_hash").notNull(),
    status: text("status").$type<DocumentStatus>().notNull(),
    route: text("route").$type<LaneRoute>(),
    /** 1-based page numbers of this segment within the parent PDF. */
    segmentPages: jsonb("segment_pages").$type<number[]>(),
    /** Classifier feature vector + score + band — logged on EVERY document (§5). */
    classifier: jsonb("classifier").$type<Record<string, unknown>>(),
    candidate: jsonb("candidate").$type<ExtractionEnvelope>(),
    /** Cached positioned-text doc — template induction at review time needs it. */
    positionedDoc: jsonb("positioned_doc").$type<Record<string, unknown>>(),
    result: jsonb("result").$type<CanonicalInvoice>(),
    markdown: text("markdown"),
    repairs: jsonb("repairs").$type<ReconciliationResult["repairs"]>(),
    violations: jsonb("violations").$type<ReconciliationResult["violations"]>(),
    vlmAttempted: boolean("vlm_attempted").notNull().default(false),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("documents_status_idx").on(t.status),
    index("documents_content_hash_idx").on(t.contentHash),
    index("documents_parent_idx").on(t.parentId),
  ],
);

/** PDF bytes, kept out of the hot documents row. */
export const documentFiles = pgTable("document_files", {
  documentId: uuid("document_id")
    .primaryKey()
    .references(() => documents.id, { onDelete: "cascade" }),
  pdf: bytea("pdf").notNull(),
});

/**
 * Append-only path trace: one row per pipeline event, written in the same
 * transaction as the stage that produced it. GET /api/documents/:id/trace and
 * the smoke CLI render the pipeline path from these rows.
 */
export const documentEvents = pgTable(
  "document_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("document_events_doc_idx").on(t.documentId)],
);

export type EscalationStage =
  | "rules_to_vlm"
  | "vlm_to_review"
  | "reclassified_markdown"
  | "xml_fallthrough"
  | "text_gate_reroute";

/** Escalation log (briefing §8): drives lexicon/rule additions and weight tuning. */
export const escalations = pgTable(
  "escalations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    stage: text("stage").$type<EscalationStage>().notNull(),
    failedConstraints: jsonb("failed_constraints").$type<unknown[]>(),
    /** Lexicon fields for which no anchor was found. */
    failedRules: jsonb("failed_rules").$type<string[]>(),
    classifierFeatures: jsonb("classifier_features").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: text("resolution"),
  },
  (t) => [index("escalations_doc_idx").on(t.documentId)],
);

export type TemplateSource = "vlm" | "human_review" | "rule_engine";

/**
 * Vendor template store (briefing §3). Identifier columns are extracted from the
 * template jsonb for indexed lookup; ALL observed identifiers are stored so any
 * one resolves the vendor later.
 */
export const vendorTemplates = pgTable(
  "vendor_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ustIdNr: text("ust_id_nr").unique(),
    steuernummer: text("steuernummer").unique(),
    /** Normalized vendor name + postal code hash — last-resort key. */
    nameHash: text("name_hash"),
    template: jsonb("template").$type<Record<string, unknown>>().notNull(),
    version: integer("version").notNull().default(1),
    source: text("source").$type<TemplateSource>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("vendor_templates_name_hash_idx").on(t.nameHash)],
);

/** Vendors print several IBANs; each maps back to one template. */
export const vendorTemplateIbans = pgTable("vendor_template_ibans", {
  iban: text("iban").primaryKey(),
  templateId: uuid("template_id")
    .notNull()
    .references(() => vendorTemplates.id, { onDelete: "cascade" }),
});
