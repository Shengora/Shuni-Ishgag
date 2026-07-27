/**
 * Timeout utilities — the single anti-freeze primitive for the whole bot.
 *
 * Rule of thumb: any call that crosses the network (MTProto, Playwright, fetch,
 * AI providers) MUST be wrapped so it can never hang a flow forever. Prefer
 * failing fast with a clear message over an unbounded wait.
 */

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label}: ${Math.round(ms / 1000)}s ichida javob bermadi (timeout).`);
    this.name = "TimeoutError";
  }
}

/**
 * Race a promise against a timeout. If it doesn't settle within `ms`, rejects
 * with a {@link TimeoutError}. The underlying operation cannot be truly
 * cancelled (JS limitation), but the caller stops waiting and can recover,
 * retry, or surface a clear error instead of freezing.
 */
export function withTimeout<T>(
  promise: PromiseLike<T>,
  ms: number,
  label = "Operatsiya",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    Promise.resolve(promise).then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function isTimeoutError(err: unknown): err is TimeoutError {
  return err instanceof TimeoutError || (err as { name?: string })?.name === "TimeoutError";
}
