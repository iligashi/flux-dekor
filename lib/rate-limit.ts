import "server-only"
import { createHash } from "node:crypto"
import { NextResponse } from "next/server"
import { createServiceRoleClient } from "@/lib/supabase/service-role"
import { createMemoryRateLimiter, createOutageReporter } from "@/lib/rate-limit-memory"

/** Limits per action: `limit` requests per `windowSeconds`, per client. */
export const RATE_LIMITS = {
  checkout: { limit: 5, windowSeconds: 600 },
  cart: { limit: 120, windowSeconds: 60 },
  wishlist: { limit: 60, windowSeconds: 60 },
  upload: { limit: 60, windowSeconds: 600 },
} as const

export type RateLimitAction = keyof typeof RATE_LIMITS

/**
 * The caller's IP as seen by Vercel's edge. `x-real-ip` is set by Vercel and
 * cannot be spoofed by the client; `x-forwarded-for` is the local fallback.
 */
export function clientIp(request: Request): string {
  const real = request.headers.get("x-real-ip")
  if (real) return real.trim()
  const forwarded = request.headers.get("x-forwarded-for")
  return forwarded?.split(",")[0]?.trim() || "unknown"
}

const memoryHit = createMemoryRateLimiter()
// console.error is what Vercel log drains / alerts pick up
const reportOutage = createOutageReporter((message) => console.error(message))

function tooManyRequests(windowSeconds: number) {
  return NextResponse.json(
    { error: "Shumë kërkesa. Ju lutem provoni përsëri pas pak minutash." },
    { status: 429, headers: { "Retry-After": String(windowSeconds) } },
  )
}

/**
 * Returns a 429 response when the client has exceeded the limit for `action`,
 * or null when the request may continue. IPs are hashed before storage.
 *
 * The shared limit lives in Postgres (check_rate_limit). If that check fails
 * the request is still limited by a per-instance in-memory counter instead of
 * being allowed unconditionally, and the outage is logged (throttled) so it is
 * visible in monitoring. Checkout keeps working during a limiter outage.
 */
export async function rateLimit(request: Request, action: RateLimitAction, subject?: string): Promise<NextResponse | null> {
  const { limit, windowSeconds } = RATE_LIMITS[action]
  const who = subject ?? clientIp(request)
  const key = `${action}:${createHash("sha256").update(who).digest("hex").slice(0, 32)}`

  // Always count locally too, so an outage does not hand out a fresh budget
  const allowedLocally = memoryHit(key, limit, windowSeconds)

  try {
    const { data, error } = await createServiceRoleClient().rpc("check_rate_limit", {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    })
    if (error || typeof data !== "boolean") {
      reportOutage(error?.message ?? "unexpected response from check_rate_limit (apply scripts/009_rate_limits_and_stock.sql)")
      return allowedLocally ? null : tooManyRequests(windowSeconds)
    }
    return data && allowedLocally ? null : tooManyRequests(windowSeconds)
  } catch (error) {
    reportOutage(error instanceof Error ? error.message : String(error))
    return allowedLocally ? null : tooManyRequests(windowSeconds)
  }
}
