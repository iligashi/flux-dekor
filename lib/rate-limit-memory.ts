/**
 * Per-instance fixed-window counters. Used as the second line of defence when
 * the database rate limiter is unavailable: weaker than the shared limit (each
 * serverless instance counts separately) but far better than no limit at all.
 */

type Window = { count: number; resetAt: number }

const MAX_KEYS = 10_000

export function createMemoryRateLimiter() {
  const windows = new Map<string, Window>()

  return function hit(key: string, limit: number, windowSeconds: number, now = Date.now()): boolean {
    const current = windows.get(key)
    if (!current || current.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + windowSeconds * 1000 })
      if (windows.size > MAX_KEYS) {
        for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k)
      }
      return limit >= 1
    }
    current.count += 1
    return current.count <= limit
  }
}

/**
 * Throttles outage reports so a database incident produces one log line per
 * interval (with a count of affected checks) instead of one per request.
 */
export function createOutageReporter(report: (message: string) => void, intervalMs = 5 * 60 * 1000) {
  let lastReportAt = -Infinity
  let suppressed = 0

  return function outage(reason: string, now = Date.now()) {
    if (now - lastReportAt < intervalMs) {
      suppressed += 1
      return
    }
    const extra = suppressed > 0 ? ` (${suppressed} more since last report)` : ""
    report(`[rate-limit] Database limiter unavailable, using in-memory fallback: ${reason}${extra}`)
    lastReportAt = now
    suppressed = 0
  }
}
