import { uuid } from "./tickets";
import type { WorkshopEnv } from "./cloud";
export { WorkshopRoom } from "./room";
export { Workspace } from "../workspace";
export { SearchIndex } from "../search-index";
export { PasswordHasher } from "../passwords";
export { Unfurler } from "../unfurl";
export { AppConnector } from "../apps/connector";
export { OutsideAi } from "../outside/endpoint";

// No upstream setup, guest sign-in, room directory or admin routes are exposed.
export default {
  async fetch(request: Request, env: WorkshopEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/up") return Response.json({ ok: true, service: "tarvis-workshop-chat" });
    const match = /^\/v1\/workshops\/([^/]+)\/(session|socket|renew|control|refresh)$/.exec(url.pathname);
    if (!match || !uuid.test(match[1]!)) return new Response(null, { status: 404 });
    if (!env.TARVIS_CHAT_SECRET || !env.TARVIS_CLOUD_URL) return new Response(null, { status: 503 });
    const origin = request.headers.get("Origin");
    // There are no cookies. Every actual request must prove a session bound to this
    // exact origin; an unrestricted preflight cannot grant access to any room.
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "600" } });
    if (Number(request.headers.get("Content-Length") || 0) > 16_384) return new Response(null, { status: 413 });
    try {
      const response = await env.WORKSHOP_ROOMS.getByName(match[1]!).fetch(request);
      if (response.status === 101) return response;
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      if (origin) { headers.set("Access-Control-Allow-Origin", origin); headers.set("Vary", "Origin"); }
      return new Response(response.body, { status: response.status, headers });
    } catch { return Response.json({ error: "Chat temporarily unavailable" }, { status: 503, headers: { "Access-Control-Allow-Origin": origin || "*", "Cache-Control": "no-store" } }); }
  },
} satisfies ExportedHandler<WorkshopEnv>;
