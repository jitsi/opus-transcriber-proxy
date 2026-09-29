# Voice-Agent Provisioning REST API — v1.0 (frozen)

Status: **frozen, v1.0**. This is the control-plane contract for placing, removing, querying and
updating voice agents in a conference. It is the companion to the media contract
(`jitsi-agent-media` v1.0, see `AGENT_PROTOCOL.md`): REST provisions the agent; the media protocol
carries its audio.

> **Implementation homes.** The canonical implementation is Jitsi's prosody module
> `mod_voice_agent_component.lua` (OSS) plus, on JaaS, the API gateway that fronts it. This file is
> co-located with the media contract during the design phase; it moves next to the prosody module
> when the upstream PRs are prepared.

## Design principle: one contract, two deployments

The **request/response schemas, status codes and semantics are identical** on Jitsi OSS and on
JaaS. Only two things differ, and both are deployment concerns, not contract concerns:

| | **Jitsi OSS (self-hosted)** | **JaaS (8x8 cloud)** |
|---|---|---|
| Base URL | prosody component, e.g. `https://<host>/voice-agent/*` | API gateway, `https://api.jaas.8x8.vc/v1/voice-agent/*` |
| Auth token | operator-issued **ASAP JWT** | **tenant** JaaS JWT / API key (gateway mints the internal ASAP) |
| Tenancy | single (the deployment); `Host` selects the MUC domain | multi-tenant; the gateway enforces tenant↔room isolation |
| Endpoint allowlist / quotas | global operator config | per-tenant config |
| Webhook secret | operator config | per-tenant config |

**Portability guarantee:** customer code (and the Pipecat bot) targets the schema below. Moving a
bot between self-hosted Jitsi and JaaS is a base-URL + credential change, nothing more. This is the
same portability the media protocol gives the serializer, and it is a hard requirement — the feature
must work for OSS, not only JaaS.

## Versioning

- The contract is **v1**. On JaaS the version is in the path (`/v1/...`). On OSS the existing
  `/voice-agent/*` routes **are** v1 (their schema is frozen here).
- Additive fields (new optional request fields, new response fields, new webhook event types) are
  backward-compatible and stay within v1; **consumers MUST ignore unknown response/webhook fields**
  (same rule as the media protocol). A breaking change bumps to `/v2` (JaaS) / a new route prefix
  (OSS).

## Authentication

`Authorization: Bearer <token>` on every request. 401 = missing/invalid token; 403 = authenticated
but not authorized for the target room/tenant.

- **OSS** — the token is an **ASAP JWT** verified against the deployment's configured ASAP key
  server (`kid`→JWKS, `iss`/`aud`/`exp`), exactly as other Jitsi service components authenticate.
  The operator issues it to whatever backend calls the API. `Host` selects the MUC domain.
- **JaaS** — the token is a **tenant credential** (a JaaS JWT, or an API key exchanged for one).
  The gateway authenticates the tenant, authorizes that the target room belongs to the tenant, then
  calls the OSS route server-to-server with a **minted system ASAP token**. The tenant never sees
  the ASAP token. (See **JaaS gateway** below.)

A dev-only escape hatch exists for local rigs (`voice_agent_insecure_skip_auth`); it is never set in
production.

## Resource model

An **agent** is identified by `agentId`, always in the reserved `agent-` namespace (a bare id is
normalized to `agent-<id>` so it can never collide with a real 8-hex participant endpoint id). It is
scoped to one **conference** (room). Its synthetic audio source is `sourceName = <agentId>-a0`.

## Endpoints

Paths shown as `<base>` = `/v1/voice-agent` (JaaS) or `/voice-agent` (OSS).

### `POST <base>/invite`

Place an agent into a conference. The control plane records it, jicofo allocates the synthetic
colibri2 endpoint, and JVB dials the agent's media WebSocket (`jitsi-agent-media` v1).

Request:
```json
{
  "conference": "room1@conference.<domain>",
  "displayName": "Support Bot",
  "agentId": "support",
  "endpoint": { "url": "wss://bot.example.com/ws", "authorization": "Bearer <secret>" },
  "urlParams": { "region": "us" },
  "httpHeaders": { "X-Trace-Id": "abc" },
  "customParameters": { "campaign": "42" },
  "callbackUrl": "https://app.example.com/jaas/agent-events"
}
```

| field | type | req | notes |
|---|---|---|---|
| `conference` | string | yes | Room JID (OSS) or JaaS room name the tenant owns. |
| `displayName` | string | yes | Roster name; length-bounded. |
| `agentId` | string | no | Suffix or full `agent-` id; charset/length-bounded; normalized to the namespace. **Idempotency key** (see below). Auto-generated if omitted. |
| `endpoint.url` | string | no* | Agent media WS; **`wss://` required** (prod). Mapped to the jicofo-only `X-Agent-Endpoint` connect header. |
| `endpoint.authorization` | string | no | Sent as `X-Agent-Authorization` on the media dial. Never exposed to room occupants. |
| `urlParams` | object(string→string) | no | Templated into the media dial URL by jicofo; bounded, CRLF/control-char rejected. |
| `httpHeaders` | object(string→string) | no | Extra headers on the media dial; `X-Agent-*` names are **reserved/rejected** here (must go via `endpoint`). |
| `customParameters` | object(string→string) | no | Opaque; echoed to the agent in the media `info`/`start` (`customParameters`). |
| `callbackUrl` | string | no | HTTPS webhook for this agent's lifecycle events (see **Webhooks**). |

\* Either `endpoint.url` or an operator/tenant-default endpoint must resolve, or the agent has
nowhere to dial.

Response `200`:
```json
{ "agentId": "agent-support", "sourceName": "agent-support-a0" }
```

Errors: `400` (invalid displayName / agentId / string-map / non-`wss` endpoint / reserved header),
`401`/`403`, `404` (room not found), `409` (per-room agent cap reached, or `agentId` conflict).

**Idempotency:** a repeated `invite` with the same `agentId` in the same conference and identical
parameters returns `200` with the existing agent (no duplicate). Same `agentId` with different
parameters → `409`.

### `POST <base>/dismiss`

Remove an agent; expires the synthetic endpoint and closes the media leg.

Request: `{ "conference": "...", "agentId": "agent-support" }`
Response: `200` `{ "agentId": "agent-support" }`; `404` if unknown.

### `GET <base>/list?conference=<id>`

Response `200`:
```json
{ "agents": {
  "agent-support": { "displayName": "Support Bot", "sourceName": "agent-support-a0", "state": "active" }
} }
```

### `GET <base>/get?conference=<id>&agentId=<id>`  *(v1 addition)*

Single-agent status. Response `200` the agent object (as in `list`); `404` if unknown.

## Agent lifecycle / state

`state` progresses: `provisioning` → `connecting` → `active` → `ended`, with `failed` on error.
Exposed by `list`/`get` and emitted as webhooks.

The transitions are reported by jicofo through an **internal** route, `POST <base>/status`
`{ conference, agentId, state, reason? }` (not part of the customer-facing surface; on JaaS the gateway
never exposes it): `connecting` when the synthetic endpoint allocation is submitted, `active` when the
bridge has accepted the endpoint and the `<connect>` is dispatched (the bridge's dial to the agent follows;
there is no separate media-leg signal yet), `failed` when allocation errors, and `ended` when the media leg
is torn down. Because jicofo cannot mint ASAP tokens, the status route also accepts a deployment shared
secret as the bearer (`voice_agent_status_secret` on the component / `jicofo.agent.status.token` on
jicofo); ASAP remains accepted, and the secret never authorizes the provisioning routes.

## Webhooks *(v1 addition)*

When `callbackUrl` is set on `invite` (or a tenant/operator default is configured), the control
plane POSTs lifecycle events so the customer backend need not poll `list`. This is the analog of
Twilio's status callbacks.

```json
{ "event": "agent.connected", "agentId": "agent-support", "conference": "room1@...",
  "sourceName": "agent-support-a0", "state": "active", "timestamp": "2026-09-25T14:00:00Z" }
```
Event types (v1): `agent.connected`, `agent.ended`, `agent.failed` (with `reason`). `agent.ended`
fires for **both** a REST `dismiss` and the media-protocol `end` event, so teardown is observable
regardless of who initiated it.

- **Signing:** `X-Agent-Signature: sha256=<hmac>` over the raw body, keyed by the per-tenant
  (OSS: per-deployment) webhook secret, so the customer can verify authenticity.
- **Delivery:** at-least-once with bounded retries/backoff; consumers dedupe on `(agentId, event,
  timestamp)`. Non-2xx or timeout → retried; persistent failure is logged, never blocks the call.

## Error model

JSON body `{ "error": "<message>" }` with the status codes above. Unknown fields in any response or
webhook MUST be ignored by clients.

## How a request flows through the system

```
invite  → control plane records the agent in room metadata (client-facing) + jicofo-only connect
          config (endpoint/urlParams/httpHeaders)
        → jicofo allocates a transport-less synthetic colibri2 endpoint + sends <connect>
        → JVB dials endpoint.url speaking jitsi-agent-media v1 → opus proxy → the agent
dismiss / media `end`
        → jicofo expires the connect → JVB expires the endpoint → agent leg closes
        → webhook agent.ended
```

---

# JaaS API gateway + tenant auth

On JaaS the OSS component is **not** exposed directly. A gateway sits in front and adds everything
multi-tenant SaaS needs, while delegating the actual work to the same OSS routes above. OSS
deployments simply omit this layer.

## What the gateway is responsible for

1. **Tenant authentication.** Verify the caller's JaaS JWT (or exchange an API key for one). The
   token carries the tenant/customer id and entitlements; the gateway rejects tenants without the
   voice-agents feature (`403`).
2. **Authorization / tenant isolation.** Resolve the request's `conference` to a room and verify it
   belongs to the calling tenant. A tenant can never invite into, dismiss from, or list another
   tenant's rooms. This is the property OSS gets for free (single tenant) and the gateway must
   enforce explicitly.
3. **Room → domain mapping.** JaaS rooms live under tenant-scoped MUC domains
   (`<tenant>.8x8.vc` style). The gateway maps the tenant's room name to the internal room JID and
   sets the `Host` the OSS component expects.
4. **Mint the internal ASAP token.** The gateway calls the OSS route server-to-server with a system
   ASAP JWT signed by the internal key the component trusts. The tenant credential never reaches the
   component; the ASAP token never reaches the tenant.
5. **Per-tenant policy the OSS layer takes globally:**
   - **Endpoint allowlist (SSRF).** OSS has one global `AGENT_ALLOWED_HOSTS`; on JaaS this becomes
     **per-tenant** — a tenant may only dial its own registered agent hosts. The gateway validates
     `endpoint.url`'s host against the tenant's allowlist before forwarding (defense in depth on top
     of the component's own private-range denylist).
   - **Quotas / rate limits.** Max concurrent agents per tenant and per room, invite rate limits.
     (OSS relies on the component's per-room cap only.)
   - **Webhook secret + callback allowlist.** Per-tenant signing secret; optional allowlist of
     permitted `callbackUrl` hosts.
6. **Webhook fan-out & billing.** The gateway is the natural place to sign/deliver webhooks and to
   meter agent-minutes for billing (it already sees connect/end lifecycle), rather than the
   component. OSS delivers webhooks straight from the component with the operator secret.

## Tenant auth token (JaaS)

A JaaS voice-agent call presents a JaaS JWT whose claims the gateway checks:

| claim | meaning |
|---|---|
| `iss` / `sub` | tenant / customer identity (maps to the JaaS AppID). |
| `aud` | JaaS API. |
| `room` | the room (or `*` for tenant-wide backends); must match the request `conference`. |
| `feature.voice-agents` (or an entitlement claim) | tenant is licensed for the feature; else `403`. |
| `exp` / `nbf` | short-lived. |

API keys are the long-lived credential a customer stores; the gateway exchanges a key for a
short-lived JWT (or verifies the key directly) and applies the same checks. The **customer's agent
endpoint secret** (`endpoint.authorization`) is unrelated to JaaS auth — it authenticates the media
dial from JVB to the customer's bot, and is carried opaquely.

## Request translation (JaaS → OSS)

```
Customer backend                Gateway                         Prosody component (OSS route)
  POST /v1/voice-agent/invite     verify tenant JWT               POST /voice-agent/invite
  Authorization: <tenant JWT>  →  authorize room↔tenant        →  Authorization: <system ASAP>
  { conference: "myroom", ... }   map room→JID, set Host           Host: <tenant muc domain>
                                  check endpoint vs allowlist       { conference: "<jid>", ... }
                               ←  200 { agentId, sourceName }    ←  200 { agentId, sourceName }
```

The body is passed through essentially unchanged (after room-name→JID rewrite and policy checks), so
the frozen schema is what both the tenant and the component see.

## OSS deployment (no gateway)

A self-hosted operator exposes the prosody component behind their own reverse proxy / network
policy and issues ASAP tokens to their backend. There is no tenant layer: the deployment *is* the
tenant. `AGENT_ALLOWED_HOSTS`, the per-room cap, and a single webhook secret are configured on the
component/env. Everything in the **Endpoints**, **Webhooks** and **Error model** sections works
identically; the operator simply owns the policy the JaaS gateway would otherwise apply per tenant.

## Conformance

The frozen request/response shapes are exercised by the prosody unit specs
(`tests/prosody/lua/mod_voice_agent_component_spec.lua`) for the OSS routes. Gateway behavior
(tenant isolation, room mapping, allowlist, webhook signing) is tested at the gateway layer against
this contract.
