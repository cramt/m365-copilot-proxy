/** Classifying M365's reasoning-turn cap (`result: OutOfCredits (ReasoningTurnExhausted)`).
 *
 *  Source: a consumer report relayed by the user (docs/hypotheses.md
 *  F181), not a captured wire frame. Some reasoning models are reported to end a
 *  turn with a final `OutOfCredits` result carrying errorCode
 *  `ReasoningTurnExhausted` once a reasoning allowance is spent, while lighter
 *  turns keep answering. Left alone the client sees a refusal dressed as an
 *  answer, and the generic `OutOfCredits` path would treat it as a priority-access
 *  budget and invent a midnight reset. This classifier lets the handler surface it
 *  as a distinct 429 without caching a reset wall.
 *
 *  No reliable reset was supplied in the report or exposed by the current result
 *  type, so no Retry-After is invented.
 */
export function capResult(result: { value?: string; errorCode?: string } | null | undefined): boolean {
  return !!result && result.value === "OutOfCredits" && result.errorCode === "ReasoningTurnExhausted";
}
