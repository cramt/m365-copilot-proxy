# Credential account policy (Node 24+)

`withAccountContext<T>(options: ModelSessionOptions, callback: (accountKey: string) => Promise<T>): Promise<T>` resolves the actual credential **before** pool lookup and known-fact checks. The key is SHA-256 of canonical `(tid, oid)` GUID claims. JWT decoding here is not signature authentication: use the existing trusted auth resolver, not a client-supplied identity or bearer token from an arbitrary proxy request.

Wrap the complete asynchronous producer lifetime, including SSE completion, in the callback. `AsyncLocalStorage` carries the pinned token/account and request attempt counter through producer awaits. A real `CopilotSession` retains storage until terminal completion as well, because `ModelSession.run` returns after the handshake. Direct `ModelSession.run` and public `CopilotSession.chat` establish their own scopes from the supplied trusted token, without a second auth/network lookup. A session bound to an account refuses another account rather than sending an old delta. Place a new account in a fresh session with full caller-supplied history; there is no durable conversation resume.

`AccountPolicyError` is exported with readonly `status`, `code`, and optional `retryAfter` **seconds**. Messages are fixed sanitized local text. Never treat these errors as network failures, refresh auth, or retry them. Codes:

- `invalid_account_principal` (401)
- `account_changed` (409)
- `account_throttle_hold`, `account_turn_budget`, `request_attempt_limit`, `route_probe_busy` (429)
- `account_policy_unavailable` (503)

## Storage and admission

`M365_ACCOUNT_POLICY_PATH` overrides the default `~/.config/opencode-m365/account-policy/state.sqlite`. New directories use 0700, the database 0600. Native `node:sqlite`, version 1 schema, `BEGIN IMMEDIATE`, 2-second busy timeout and rollback journal serialize account admissions across processes. Store errors/unknown versions fail closed. Native table/index inspection verifies types, nullability, primary/index keys, and persisted row types/ranges/enums before callback or pruning; malformed existing stores are not repaired or recreated. Expired facts/leases and attempts older than 72h are pruned at scope entry. Storage refuses more than 100000 rows per table at scope entry or a database larger than 64MiB; SQLite also limits page allocation. It never imports old prompt-bearing debug logs into authenticated account policy.

The journal contains only hashed principal, attempt timestamp and first-thread-turn flag. Facts contain bounded enums, hashed route dimensions, observation/expiry times; account rows contain approximate bucket state and operator cooldown deadline. No tokens, prompts, tool results or upstream freeform refusal text are persisted. Priority reads reconstruct sanitized text and retain existing reset-on-read expiry semantics. Their calendar resets remain existing inferred policy, not newly proven upstream guarantees.

Known priority dimensions retain `opus` and `sonnet-5.5`. Other model identifiers
are bounded to 256 UTF-16 code units and stored only as `model-sha256:<digest>`.
Write admission and persisted-row validation share the same closed fact contract;
invalid dimensions, enum values or timestamps are rejected before mutation.

Every public chat/reconnect is atomically admitted exactly once at `CopilotSession.chat`, including direct low-level calls; ModelSession adds no duplicate debit. Existing `recordTurn` and `awaitTurnBudget` do not add duplicate log debits/reservations inside authenticated scope. `M365_REQUEST_MAX_ATTEMPTS` defaults to 3 and clamps to integer 1..10, shared across hidden retries/reconnect/fallback within one callback.

The learned throttle hold is **always** enforced, even when avoidance is disabled. `M365_BUDGET_HOLD_MIN` defaults to 75, clamped 1..1440; this is operator cooldown policy, not a claimed Microsoft reset. `M365_AVOID_THROTTLING` retains opt-in approximate bucket admission (capacity/refill/reserve settings). Authenticated chat admission waits and atomically rechecks when avoidance is enabled and the wait fits `M365_BUDGET_MAX_WAIT_MIN` (default 15), with cancellation; otherwise it refuses locally. The no-context legacy wait API remains for offline callers/tests. This estimate cannot see traffic from other hosts, first-party clients or processes using another database.

## Route freshness

Positive, suspect and negative observations have bounded TTL, default 15min (`M365_ROUTE_FACT_TTL_MS`, 1ms..24h). A fresh alive fact suppresses one-off transient death classification; after expiry it cannot mask new evidence. One `InternalError` only records **suspect**, permitting same-request agent-less fallback without establishing durable dead/licence denial. Another observation within the TTL can establish dead; this is still heuristic, never proof of licence status. Timeouts do not call the death recorder.

`requestUsesAgent(model, hasTools)` establishes scenario internally before tone-only route helpers are consulted. Route dimensions include tone, scenario, force-agent configuration and `ModelSessionOptions.accountRouteScope` (default `default-agent-v1`). Set the latter to a stable protocol/agent-configuration identity when varying that configuration. Missing/expired premium-only route facts acquire an atomic 120s generation lease, renewed every 30s and on active stream traffic; competing requests receive retryable `route_probe_busy`. Publications and release are fenced by the owned generation. Renewal failure fails the stream closed; expired generations cannot resurrect or publish after a replacement. Callback/active-stream completion releases owned leases; process crashes rely on bounded lease expiry. Terminal cleanup always settles the stream, clears timers/abort listeners and closes or terminates the socket even when storage release fails.

Scoped agent resolution ignores the legacy unscoped `agent-id.json`; agent IDs and explicit extensibility-policy denials have bounded per-principal in-memory caches. Scoped BAP/PowerPlatform tokens must match the pinned principal before any HTTP. ModelSession reconsults those bounded caches on every next agent turn (no immortal ID/null shadow). Pure helpers called without authenticated context retain explicitly legacy volatile compatibility state; production proxy requests must establish context first.

## Verification boundary

Synthetic native tests exercise GUID parsing, account switching, callback/stream ownership, real SQLite cross-process contention and restart reads, cooldown, bounded request attempts, expiry/leases, scenario/config isolation, corrupt/unknown schema refusal, finite lock wait, private modes and no raw principal/freeform message storage. No live Microsoft continuity, quota reset or entitlement validation is claimed.
