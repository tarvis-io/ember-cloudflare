# Tarvis workshop adapter

This deployment uses Ember's ChatRoom storage, message protocol, history, presence,
validation and fan-out with a separate Cloud-authorized entrypoint. It does not
expose Ember's public setup, guest login, admin UI or room directory. The normal
Ember deployment remains unchanged.

## Deploy the isolated test service

`pnpm install --frozen-lockfile`

`pnpm exec wrangler deploy --config wrangler.workshop.jsonc`

Set `TARVIS_CHAT_SECRET` and `SESSION_SECRET` with Wrangler secrets. Use independent
random values of at least 32 characters. Set the same chat secret as
`WORKSHOP_CHAT_SECRET` on Cloud; never send either secret to Workspace or commit it.
`TARVIS_CLOUD_URL` names the Cloud deployment hosting `/api/workshop-chat/service`.
The checked-in config deploys only `tarvis-workshop-chat-test` on workers.dev.
There are no production zone routes, uploads or email bindings.

## Authentication and authorization

Cloud verifies the signed-in user and redemption (or instructor assignment), then
issues a 60-second HS256 grant bound to the workshop, exact browser origin and PKCE
challenge. It sends that grant only to the initiating popup's exact opener origin.
The room validates the proof, consumes the grant ID atomically, and stores only a
digest of a random 15-minute session token. Sessions renew after Cloud revalidation.
Tokens are held in browser memory and sent in Authorization or a WebSocket
subprotocol, never URLs, cookies or localStorage.

Each room is a separate Durable Object named by the immutable trial policy UUID.
Every message revalidates membership and instructor policy with Cloud; hiding a
button is never authorization. A signed backend refresh closes revoked sessions;
active rooms additionally recheck every 15 seconds, including idle sockets. Cloud
failure fails chat closed. The Workshop VM has no chat user credential.

Cloud owns instructor controls and the current pinned announcement. Policy
revisions prevent old responses from overwriting newer state. One broadcast per
revision avoids fan-out growing quadratically with the participant count.

## Protocol

- POST `/v1/workshops/:id/session`: `{code, verifier}` with exact Origin.
- GET `/v1/workshops/:id/socket?protocol=4&visible=1`: WebSocket subprotocols
  `tarvis-chat`, then session token. Uses Ember protocol v4 plus `workshop.state`
  (`packages/protocol/src/workshop.ts`).
- POST `renew`: session Authorization, exact Origin; extends expiry by 15 minutes.
- POST `control`: instructor session; `{discussionEnabled}` or `{announcement}`.
- POST `refresh`: backend shared secret; revalidates connected users.

The first version permits messages, presence and history reads. Uploads, DMs,
message editing, AI tools and room administration are intentionally not exposed.
Instructors can post while discussion is paused. Announcements have their own
state, so they remain prominent when the panel is closed.

## Verification

`pnpm typecheck && pnpm test && pnpm build`

`pnpm --filter @ember/worker test:workshop`

The workshop runtime suite covers PKCE/signature/origin/room checks, grant replay,
participant vs instructor privileges, live pause enforcement, real Ember delivery,
20-participant fan-out, revoked membership and inaccessible upstream endpoints.
The performance smoke is a local functional/load check, not a production capacity
claim; production throughput also depends on Cloud authorization latency.

Rollback: turn off chat on the trial policy (refresh/revalidation revokes sessions),
then disable the Cloud feature flag. Do not delete Durable Objects to roll back;
messages remain available if the feature is re-enabled.
