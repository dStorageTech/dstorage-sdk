/**
 * Error-chain helpers for the console demo.
 *
 * The Midnight wallet SDK is built on Effect, whose errors nest the real
 * failure in places a plain `.cause` walk doesn't reach.
 */

// Effect (used by the Midnight wallet SDK) wraps failures in a FiberFailure
// whose real error lives under this symbol, not in `.cause`.
const EFFECT_FIBER_FAILURE_CAUSE = Symbol.for(
  "effect/Runtime/FiberFailure/Cause",
);

/** Find the first failure/defect inside an Effect `Cause` tree. */
function findEffectFailure(cause: unknown, depth = 0): unknown {
  if (!cause || typeof cause !== "object" || depth > 20) return undefined;
  const c = cause as Record<string, unknown>;
  if (c["_tag"] === "Fail") return c["error"];
  if (c["_tag"] === "Die") return c["defect"];
  return (
    findEffectFailure(c["left"], depth + 1) ??
    findEffectFailure(c["right"], depth + 1)
  );
}

export function nextCause(err: unknown): unknown {
  if (!err || typeof err !== "object") return undefined;
  const effectCause = (err as Record<symbol, unknown>)[
    EFFECT_FIBER_FAILURE_CAUSE
  ];
  if (effectCause !== undefined) return findEffectFailure(effectCause);
  return (err as { cause?: unknown }).cause;
}

export function describeCause(cause: unknown): string {
  const json = (v: unknown) => {
    try {
      return JSON.stringify(v, (_, x) =>
        typeof x === "bigint"
          ? x.toString()
          : x instanceof Uint8Array
            ? `<${x.length} bytes>`
            : x,
      );
    } catch {
      return String(v);
    }
  };
  if (cause instanceof Error) {
    // Tagged errors (Data.TaggedError) carry extra fields beyond message.
    const {
      cause: _cause,
      name: _name,
      ...extra
    } = cause as Error & Record<string, unknown>;
    const extraJson = Object.keys(extra).length ? ` ${json(extra)}` : "";
    return `${cause.name}: ${cause.message}${extraJson}`;
  }
  return typeof cause === "object" ? json(cause) : String(cause);
}

/**
 * True when the error chain contains a polkadot.js "disconnected from <node>"
 * failure, i.e. the request was sent on a node WebSocket that was closing.
 */
export function isNodeSocketClosedError(err: unknown): boolean {
  for (
    let c: unknown = err, depth = 0;
    c !== undefined && depth < 10;
    depth++
  ) {
    if (c instanceof Error && /^disconnected from /.test(c.message))
      return true;
    c = nextCause(c);
  }
  return false;
}
