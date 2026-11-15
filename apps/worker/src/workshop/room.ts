import { ChatRoom, USER_HEADER, ROOM_HEADER, SESSION_HEADER, AUTHORIZED_AT_HEADER } from "../chat-room";
import { workspace } from "../workspace";
import { sessionTag } from "../revocations";
import { cloudMember, type Member, type WorkshopEnv, type WorkshopState } from "./cloud";
import { digest, verifyGrant } from "./tickets";

interface Session { userId: string; origin: string; expires: number; workshop: string }
interface WorkshopAttachment { workshopSession?: string }
const ttl = 15 * 60_000;
const allowedFrames = new Set(["ping", "message.create", "history.before", "message.check", "typing.start", "typing.stop", "visibility"]);

/** Isolated deployment: upstream room storage/protocol, Cloud-owned access and controls. */
export class WorkshopRoom extends ChatRoom {
  private workshopEnv: WorkshopEnv;
  constructor(ctx: DurableObjectState, env: WorkshopEnv) { super(ctx, env); this.workshopEnv = env; }

  private async member(key: string, origin?: string): Promise<{ session: Session; member: Member } | null> {
    const session = await this.ctx.storage.get<Session>(`session:${key}`);
    if (!session || session.expires <= Date.now() || (origin !== undefined && session.origin !== origin)) return null;
    const member = await cloudMember(this.workshopEnv, session.workshop, session.userId);
    return member ? { session, member } : null;
  }

  private async publishState(state: WorkshopState) {
    const previous = await this.ctx.storage.get<WorkshopState>("workshopState");
    if (previous && previous.revision >= state.revision) return;
    await this.ctx.storage.put("workshopState", state);
    for (const ws of this.ctx.getWebSockets()) ws.send(JSON.stringify({ type: "workshop.state", state }));
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/");
    const id = parts[3]!;
    const action = parts[4];
    const origin = request.headers.get("Origin") || "";
    if (action === "session" && request.method === "POST") {
      const body = await request.json<{ code?: string; verifier?: string }>().catch(() => null);
      const grant = body && typeof body.code === "string" && typeof body.verifier === "string" && await verifyGrant(body.code, body.verifier, this.workshopEnv.TARVIS_CHAT_SECRET, id, origin);
      if (!grant) return Response.json({ error: "Invalid or expired authorization" }, { status: 401 });
      const member = await cloudMember(this.workshopEnv, id, grant.sub);
      if (!member) return Response.json({ error: "Access denied" }, { status: 403 });
      const sessions = await this.ctx.storage.list<Session>({ prefix: "session:" });
      const existing = [...sessions.values()].filter(s => s.userId === grant.sub && s.expires > Date.now());
      if (existing.length >= 16 || sessions.size >= 4000) return Response.json({ error: "Too many chat sessions; try again later" }, { status: 429 });
      const token = crypto.randomUUID() + crypto.randomUUID();
      const key = await digest(token);
      const used = await this.ctx.storage.transaction(async tx => {
        if (await tx.get(`grant:${grant.jti}`)) return true;
        await tx.put(`grant:${grant.jti}`, grant.exp * 1000);
        await tx.put(`session:${key}`, { userId: grant.sub, workshop: id, origin, expires: Date.now() + ttl } satisfies Session);
        return false;
      });
      if (used) return Response.json({ error: "Authorization already used" }, { status: 401 });
      await workspace(this.workshopEnv).registerWorkshopMember(id, member.state.name, member.user);
      await this.publishState(member.state);
      await this.wake();
      return Response.json({ token, ...member });
    }
    if (action === "refresh" && request.method === "POST") {
      if (await digest(request.headers.get("Authorization") || "") !== await digest(`Bearer ${this.workshopEnv.TARVIS_CHAT_SECRET}`)) return new Response(null, { status: 401 });
      await this.refresh();
      return Response.json({ ok: true });
    }
    const protocols = request.headers.get("Sec-WebSocket-Protocol")?.split(",").map(v => v.trim());
    const token = request.headers.get("Authorization")?.replace(/^Bearer /, "") || (protocols?.[0] === "tarvis-chat" ? protocols[1] : "");
    if (!token || token.length > 200) return new Response(null, { status: 401 });
    const key = await digest(token);
    const access = await this.member(key, origin);
    if (!access || access.session.workshop !== id) return new Response(null, { status: 403 });
    if (action === "socket" && request.headers.get("Upgrade") === "websocket") {
      const headers = new Headers({ Upgrade: "websocket", [USER_HEADER]: JSON.stringify(access.member.user).replace(/[\u007f-\uffff]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")), [ROOM_HEADER]: id, [SESSION_HEADER]: key, [AUTHORIZED_AT_HEADER]: String(Date.now()) });
      const response = await super.fetch(new Request(request.url, { headers }));
      for (const ws of this.ctx.getWebSockets(sessionTag(key))) {
        ws.serializeAttachment({ ...ws.deserializeAttachment(), workshopSession: key });
        ws.send(JSON.stringify({ type: "workshop.state", state: access.member.state }));
      }
      await this.wake();
      return new Response(null, { status: response.status, webSocket: response.webSocket, headers: { "Sec-WebSocket-Protocol": "tarvis-chat" } });
    }
    if (action === "renew" && request.method === "POST") {
      await this.ctx.storage.put(`session:${key}`, { ...access.session, expires: Date.now() + ttl });
      return Response.json(access.member);
    }
    if (action === "control" && request.method === "POST") {
      if (!access.member.instructor) return new Response(null, { status: 403 });
      const control = await request.json().catch(() => null);
      if (!control || typeof control !== "object") return new Response(null, { status: 400 });
      const changed = await cloudMember(this.workshopEnv, id, access.session.userId, control);
      if (!changed) return new Response(null, { status: 403 });
      await this.publishState(changed.state);
      return Response.json(changed);
    }
    return new Response(null, { status: 404 });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    try {
      const frame = typeof raw === "string" && raw.length <= 16_384 ? JSON.parse(raw) : null;
      if (!frame || !allowedFrames.has(frame.type)) { ws.send(JSON.stringify({ type: "error", message: "Unsupported workshop action" })); return; }
      const attachment = ws.deserializeAttachment() as WorkshopAttachment;
      const access = attachment.workshopSession && await this.member(attachment.workshopSession);
      if (!access) { ws.close(4403, "Workshop access ended"); return; }
      if ((frame.type === "message.create" || frame.type === "typing.start") && !access.member.instructor && !access.member.state.discussionEnabled) {
        ws.send(JSON.stringify({ type: "error", message: "Discussion paused by your instructor", clientMessageId: frame.clientMessageId })); return;
      }
      // Preserve Ember's validation, idempotency, storage, presence and broadcasting.
      await super.webSocketMessage(ws, raw);
    } catch { ws.send(JSON.stringify({ type: "error", message: "Chat temporarily unavailable. Please retry." })); }
  }

  private async wake() {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > Date.now() + 15_000) await this.ctx.storage.setAlarm(Date.now() + 15_000);
  }
  private async refresh() {
    const checked = new Map<string, Awaited<ReturnType<WorkshopRoom["member"]>>>();
    for (const ws of this.ctx.getWebSockets()) {
      const key = (ws.deserializeAttachment() as WorkshopAttachment).workshopSession;
      if (!key) continue;
      if (!checked.has(key)) checked.set(key, await this.member(key).catch(() => null));
      const access = checked.get(key);
      if (!access) ws.close(4403, "Workshop access ended");
      else await this.publishState(access.member.state);
    }
  }
  override async alarm() {
    await super.alarm();
    await this.refresh();
    for (const [key, expires] of await this.ctx.storage.list<number>({ prefix: "grant:" })) if (expires < Date.now()) await this.ctx.storage.delete(key);
    for (const [key, session] of await this.ctx.storage.list<Session>({ prefix: "session:" })) if (session.expires < Date.now()) await this.ctx.storage.delete(key);
    if (this.ctx.getWebSockets().length || (await this.ctx.storage.list({ prefix: "session:", limit: 1 })).size) await this.wake();
  }
}
