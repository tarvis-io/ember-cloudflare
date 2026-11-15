import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exports } from "cloudflare:workers";
import { digest, verifyGrant } from "../src/workshop/tickets";

const secret = "test-workshop-secret-at-least-32-characters";
const origin = "https://attendee.example.com";
const instructor = "00000000-0000-4000-8000-000000000001";
const participant = "00000000-0000-4000-8000-000000000002";
const viewer = "00000000-0000-4000-8000-000000000003";
let enabled = true;
let discussion = true;
let revision = 1;
const encode = (s: string) => btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
async function grant(workshop: string, user: string, verifier: string) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: user, workshop, origin, challenge: await digest(verifier), jti: crypto.randomUUID(), iss: "tarvis-cloud", aud: "tarvis-workshop-chat", exp: now + 60, iat: now };
  const input = encode(JSON.stringify({ alg: "HS256" })) + "." + encode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)));
  return input + "." + encode(String.fromCharCode(...signature));
}
function api(id: string, path: string, token?: string, body?: unknown, from = origin) {
  return exports.default.fetch(`https://chat.test/v1/workshops/${id}/${path}`, { method: "POST", headers: { Origin: from, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) });
}
async function login(id: string, user = participant) {
  const verifier = "v".repeat(64);
  const code = await grant(id, user, verifier);
  const response = await api(id, "session", undefined, { code, verifier });
  expect(response.status).toBe(200);
  const result = await response.json<{ token: string }>();
  return { ...result, code, verifier };
}
function frames(ws: WebSocket) {
  const queued: any[] = [];
  const waiters: ((frame: any) => void)[] = [];
  ws.addEventListener("message", e => { const f = JSON.parse(e.data as string); const next = waiters.shift(); if (next) next(f); else queued.push(f); });
  return async (type: string): Promise<any> => {
    for (;;) { const f = queued.shift() ?? await new Promise(resolve => waiters.push(resolve)); if (f.type === type) return f; }
  };
}
async function socket(id: string, token: string) {
  const response = await exports.default.fetch(`https://chat.test/v1/workshops/${id}/socket?protocol=4&visible=1`, { headers: { Origin: origin, Upgrade: "websocket", "Sec-WebSocket-Protocol": `tarvis-chat, ${token}` } });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const next = frames(ws); ws.accept(); await next("welcome");
  return { ws, next };
}
beforeEach(() => {
  enabled = true; discussion = true; revision = 1;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
    if (String(request) !== "https://cloud.test/api/workshop-chat/service") throw new Error("Unexpected outbound request");
    const body = JSON.parse(init?.body as string);
    if (!enabled || body.userId === viewer) return Response.json({ error: "Denied" }, { status: 403 });
    if (body.control) { if (body.userId !== instructor) return Response.json({}, { status: 403 }); discussion = body.control.discussionEnabled ?? discussion; revision++; }
    return Response.json({ user: { id: body.userId, name: body.userId === instructor ? "Instructor" : "Participant" }, instructor: body.userId === instructor, state: { id: body.workshop, name: "Test workshop", enabled, discussionEnabled: discussion, announcement: null, revision } });
  });
});
afterEach(() => vi.restoreAllMocks());

describe("workshop authorization", () => {
  it("requires signature, exact origin, room and PKCE proof", async () => {
    const id = crypto.randomUUID(), verifier = "v".repeat(64);
    const token = await grant(id, participant, verifier);
    expect(await verifyGrant(token, verifier, secret, id, origin)).not.toBeNull();
    expect(await verifyGrant(token, "x".repeat(64), secret, id, origin)).toBeNull();
    expect(await verifyGrant(token, verifier, secret, crypto.randomUUID(), origin)).toBeNull();
    expect(await verifyGrant(token, verifier, secret, id, "https://evil.test")).toBeNull();
    expect(await verifyGrant(token + "a", verifier, secret, id, origin)).toBeNull();
  });
  it("rejects replay, cross-room and cross-origin sessions", async () => {
    const id = crypto.randomUUID(), session = await login(id);
    expect((await api(id, "session", undefined, { code: session.code, verifier: session.verifier })).status).toBe(401);
    expect((await api(crypto.randomUUID(), "renew", session.token)).status).toBe(403);
    expect((await api(id, "renew", session.token, {}, "https://evil.test")).status).toBe(403);
    expect((await api(id, "control", session.token, { discussionEnabled: false })).status).toBe(403);
  });
  it("uses Ember delivery and enforces instructor pause on already-open sockets", async () => {
    const id = crypto.randomUUID();
    const student = await login(id), teacher = await login(id, instructor);
    const a = await socket(id, student.token), b = await socket(id, teacher.token);
    try {
      a.ws.send(JSON.stringify({ type: "message.create", clientMessageId: crypto.randomUUID(), body: "<p>Hello workshop</p>" }));
      expect((await b.next("message.created")).message.plainText).toBe("Hello workshop");
      expect((await api(id, "control", teacher.token, { discussionEnabled: false })).status).toBe(200);
      await a.next("workshop.state");
      a.ws.send(JSON.stringify({ type: "message.create", clientMessageId: crypto.randomUUID(), body: "<p>Should be blocked</p>" }));
      expect((await a.next("error")).message).toContain("paused");
      b.ws.send(JSON.stringify({ type: "message.create", clientMessageId: crypto.randomUUID(), body: "<p>Instructor still speaks</p>" }));
      expect((await a.next("message.created")).message.plainText).toBe("Instructor still speaks");
    } finally { a.ws.close(); b.ws.close(); }
  });
  it("rejects removed membership and hides all upstream setup routes", async () => {
    const id = crypto.randomUUID(), session = await login(id);
    enabled = false;
    expect((await api(id, "renew", session.token)).status).toBe(403);
    expect((await exports.default.fetch("https://chat.test/api/first_run")).status).toBe(404);
    expect((await exports.default.fetch("https://chat.test/api/session")).status).toBe(404);
  });
  it("fans out one message to 20 participants without duplicates", async () => {
    const id = crypto.randomUUID();
    const connections = [];
    for (let i = 0; i < 20; i++) {
      const session = await login(id, crypto.randomUUID());
      connections.push(await socket(id, session.token));
    }
    try {
      const start = Date.now();
      const received = connections.map(c => c.next("message.created"));
      connections[0]!.ws.send(JSON.stringify({ type: "message.create", clientMessageId: crypto.randomUUID(), body: "<p>Workshop fanout</p>" }));
      const messages = await Promise.all(received);
      expect(new Set(messages.map(f => f.message.id)).size).toBe(1);
      expect(messages.every(f => f.message.plainText === "Workshop fanout")).toBe(true);
      expect(Date.now() - start).toBeLessThan(5000);
    } finally { connections.forEach(c => c.ws.close()); }
  });

});
