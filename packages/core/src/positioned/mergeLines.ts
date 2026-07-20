import type { PositionedLine, PositionedTextDocument } from "./model";

/**
 * OCR output arrives as word/fragment-level items; label matching and template
 * anchors want visual LINES. Cluster items by vertical center per page and
 * merge them left-to-right, keeping the original tokens (with their bboxes) —
 * x-band table extraction needs those.
 */
export function mergeLines(doc: PositionedTextDocument, yTolerance = 0.008): PositionedTextDocument {
  const byPage = new Map<number, PositionedLine[]>();
  for (const line of doc.lines) {
    const list = byPage.get(line.page) ?? [];
    list.push(line);
    byPage.set(line.page, list);
  }

  const merged: PositionedLine[] = [];
  for (const [page, lines] of byPage.entries()) {
    const sorted = [...lines].sort(
      (a, b) => (a.bbox[1] + a.bbox[3]) / 2 - (b.bbox[1] + b.bbox[3]) / 2,
    );
    let cluster: PositionedLine[] = [];
    let clusterY = -1;

    const flush = () => {
      if (cluster.length === 0) return;
      const parts = [...cluster].sort((a, b) => a.bbox[0] - b.bbox[0]);
      merged.push({
        text: parts.map((p) => p.text).join(" "),
        page,
        bbox: [
          Math.min(...parts.map((p) => p.bbox[0])),
          Math.min(...parts.map((p) => p.bbox[1])),
          Math.max(...parts.map((p) => p.bbox[2])),
          Math.max(...parts.map((p) => p.bbox[3])),
        ],
        tokens: parts.flatMap((p) => p.tokens),
        ...(parts.find((p) => p.tag)?.tag ? { tag: parts.find((p) => p.tag)!.tag! } : {}),
      });
      cluster = [];
    };

    for (const line of sorted) {
      const y = (line.bbox[1] + line.bbox[3]) / 2;
      if (cluster.length > 0 && Math.abs(y - clusterY) > yTolerance) flush();
      cluster.push(line);
      clusterY = y;
    }
    flush();
  }

  merged.sort((a, b) => a.page - b.page || a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  return { ...doc, lines: merged };
}
