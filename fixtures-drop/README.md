# fixtures-drop

Drop real sample PDFs here (git-ignored). Then run the batch harness against a running server:

```bash
pnpm smoke -- ./fixtures-drop
```

It ingests every PDF, waits for a terminal status, and prints one row per document with the
full path taken (route, gate verdict, vendor/template resolution, classifier band, solver
repairs/violations, escalations) sourced from the document event trace.

Optional outcome assertions:

```bash
pnpm smoke -- ./fixtures-drop --expect ./fixtures-drop/expected.json
```

`expected.json` maps filename to expected outcomes, e.g.:

```json
{
  "acme-2026-001.pdf": {
    "route": "text",
    "terminalStatus": "committed",
    "gross": "119.00",
    "lineCount": 3
  }
}
```

Real samples are what tune the lexicon, segmentation heuristics, and classifier bands —
escalation logs (`GET /api/escalations`) point at what to fix.
