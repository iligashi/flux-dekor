import { beforeEach, describe, expect, it, vi } from "vitest"
import { createMemoryRateLimiter, createOutageReporter } from "@/lib/rate-limit-memory"
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit"

vi.mock("server-only", () => ({}))

// vi.mock calls are hoisted above the imports, so the mock must be hoisted too
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock("@/lib/supabase/service-role", () => ({
  createServiceRoleClient: () => ({ rpc }),
}))

let ipCounter = 0
const requestFromNewIp = () => new Request("https://shop.test/api/orders", { headers: { "x-real-ip": `10.0.0.${++ipCounter}` } })

describe("createMemoryRateLimiter", () => {
  it("allows up to the limit per window, then blocks until it resets", () => {
    const hit = createMemoryRateLimiter()
    const now = 1_000_000
    expect(hit("k", 2, 60, now)).toBe(true)
    expect(hit("k", 2, 60, now + 1)).toBe(true)
    expect(hit("k", 2, 60, now + 2)).toBe(false)
    expect(hit("k", 2, 60, now + 60_000)).toBe(true)
  })

  it("counts keys independently", () => {
    const hit = createMemoryRateLimiter()
    expect(hit("a", 1, 60)).toBe(true)
    expect(hit("b", 1, 60)).toBe(true)
    expect(hit("a", 1, 60)).toBe(false)
  })
})

describe("createOutageReporter", () => {
  it("reports at most once per interval and counts suppressed events", () => {
    const messages: string[] = []
    const outage = createOutageReporter((m) => messages.push(m), 1000)
    outage("db down", 0)
    outage("db down", 10)
    outage("db down", 20)
    outage("db down", 1500)
    expect(messages).toHaveLength(2)
    expect(messages[1]).toContain("2 more since last report")
  })
})

describe("rateLimit", () => {
  beforeEach(() => {
    rpc.mockReset()
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("follows the database decision when it is available", async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null })
    expect(await rateLimit(requestFromNewIp(), "checkout")).toBeNull()

    rpc.mockResolvedValueOnce({ data: false, error: null })
    const blocked = await rateLimit(requestFromNewIp(), "checkout")
    expect(blocked?.status).toBe(429)
  })

  it("does not fail open when the database function errors", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "function check_rate_limit does not exist" } })
    const request = requestFromNewIp()
    const { limit } = RATE_LIMITS.checkout

    for (let i = 0; i < limit; i++) expect(await rateLimit(request, "checkout")).toBeNull()
    expect((await rateLimit(request, "checkout"))?.status).toBe(429)
    expect(console.error).toHaveBeenCalled()
  })

  it("does not fail open when the database call throws", async () => {
    rpc.mockRejectedValue(new Error("fetch failed"))
    const request = requestFromNewIp()
    const { limit } = RATE_LIMITS.checkout

    for (let i = 0; i < limit; i++) await rateLimit(request, "checkout")
    expect((await rateLimit(request, "checkout"))?.status).toBe(429)
  })

  it("keeps blocking a client that burst past the limit even if the database lets it through", async () => {
    rpc.mockResolvedValue({ data: true, error: null })
    const request = requestFromNewIp()
    const { limit } = RATE_LIMITS.checkout

    for (let i = 0; i < limit; i++) await rateLimit(request, "checkout")
    expect((await rateLimit(request, "checkout"))?.status).toBe(429)
  })
})
