import type { Env } from "../env";
import type { WorkshopState } from "@ember/protocol";
export type { WorkshopState } from "@ember/protocol";
export interface Member { user: { id: string; name: string }; instructor: boolean; state: WorkshopState }
export interface WorkshopEnv extends Env { WORKSHOP_ROOMS: DurableObjectNamespace<import("./room").WorkshopRoom>; TARVIS_CLOUD_URL: string; TARVIS_CHAT_SECRET: string }
export async function cloudMember(env: WorkshopEnv, workshop: string, userId: string, control?: unknown): Promise<Member | null> {
  const url = new URL("/api/workshop-chat/service", env.TARVIS_CLOUD_URL);
  if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error("Cloud requires HTTPS");
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${env.TARVIS_CHAT_SECRET}`, "Content-Type": "application/json" }, body: JSON.stringify({ workshop, userId, ...(control === undefined ? {} : { control }) }), signal: AbortSignal.timeout(5000) });
  if (response.status === 403) return null;
  if (!response.ok) throw new Error("Cloud authorization unavailable");
  const member = await response.json<Member>();
  if (member.user?.id !== userId || member.state?.id !== workshop || !member.state.enabled || typeof member.instructor !== "boolean") throw new Error("Invalid Cloud authorization");
  return member;
}
