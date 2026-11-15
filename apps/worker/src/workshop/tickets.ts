/** Cloud grants are single-use, PKCE-bound and valid for at most one minute. */
export interface Grant { sub: string; workshop: string; origin: string; challenge: string; jti: string; exp: number; iat: number }
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const decode = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
export async function digest(value: string) { return encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))); }
export async function verifyGrant(token: string, verifier: string, secret: string, workshop: string, origin: string): Promise<Grant | null> {
  try {
    if (token.length > 4096 || !/^[a-zA-Z0-9_-]{43,128}$/.test(verifier) || secret.length < 32) return null;
    const [header, body, signature, extra] = token.split(".");
    if (!header || !body || !signature || extra || JSON.parse(new TextDecoder().decode(decode(header))).alg !== "HS256") return null;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("HMAC", key, decode(signature), new TextEncoder().encode(`${header}.${body}`))) return null;
    const grant = JSON.parse(new TextDecoder().decode(decode(body)));
    const now = Math.floor(Date.now() / 1000);
    if (grant.iss !== "tarvis-cloud" || grant.aud !== "tarvis-workshop-chat" || !uuid.test(grant.sub) || !uuid.test(grant.jti) || grant.workshop !== workshop || grant.origin !== origin || !Number.isInteger(grant.exp) || !Number.isInteger(grant.iat) || grant.iat > now + 5 || grant.exp <= now || grant.exp - grant.iat > 60 || grant.challenge !== await digest(verifier)) return null;
    return grant;
  } catch { return null; }
}
