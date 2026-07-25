import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/**
 * A real HTTP server on 127.0.0.1:0 for testing docling.ts and openaiCompat.ts.
 *
 * Deliberately NOT undici's MockAgent. Those two clients are almost entirely WIRE
 * code — base64 framing, AbortSignal.timeout, res.ok handling, `await res.text()`
 * in the error path, JSON parsing, fence stripping. A MockAgent interceptor
 * replaces the dispatcher, so it cannot prove that a timeout actually aborts a
 * socket, cannot produce a genuine connection reset, and would promote undici
 * from a transitive dependency to a direct one. A loopback server costs about a
 * millisecond per test and exercises the real path.
 */

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface StubResponse {
  status?: number;
  /** Serialized with JSON.stringify and sent as application/json. */
  json?: unknown;
  /** Sent verbatim; use for non-JSON bodies (HTML error pages, truncated JSON). */
  text?: string;
  headers?: Record<string, string>;
  /** Delay before responding — drives client-timeout tests. */
  delayMs?: number;
  /** Destroy the socket without replying — drives connection-reset tests. */
  hangUp?: boolean;
}

export interface StubServer {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

type Handler = (req: RecordedRequest, callIndex: number) => StubResponse | Promise<StubResponse>;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, r: StubResponse): void {
  const status = r.status ?? 200;
  if (r.text !== undefined) {
    res.writeHead(status, { "content-type": "text/plain", ...r.headers });
    res.end(r.text);
    return;
  }
  res.writeHead(status, { "content-type": "application/json", ...r.headers });
  res.end(JSON.stringify(r.json ?? {}));
}

export async function startStubServer(handler: Handler): Promise<StubServer> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((req, res) => {
    void (async () => {
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")]),
        ),
        body: await readBody(req),
      };
      const index = requests.length;
      requests.push(recorded);

      let reply: StubResponse;
      try {
        reply = await handler(recorded, index);
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(String(err));
        return;
      }

      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      if (reply.hangUp) {
        req.socket.destroy();
        return;
      }
      // The client may have aborted during delayMs; writing to a dead socket throws.
      if (!res.writableEnded && !res.destroyed) send(res, reply);
    })();
  });

  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Destroy keep-alive sockets first, or close() hangs until they idle out.
        for (const s of sockets) s.destroy();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Convenience: a fixed queue of responses, consumed in order; the last one repeats. */
export function startStubQueue(responses: StubResponse[]): Promise<StubServer> {
  return startStubServer((_req, i) => responses[Math.min(i, responses.length - 1)] ?? { status: 200 });
}

/** A port with nothing listening on it — for ECONNREFUSED tests. */
export async function closedPortUrl(): Promise<string> {
  const s = await startStubServer(() => ({ status: 200 }));
  const url = s.url;
  await s.close();
  return url;
}
