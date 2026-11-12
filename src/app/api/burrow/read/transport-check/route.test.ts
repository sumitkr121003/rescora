import { describe, expect, it, vi } from "vitest";
import { POST } from "./route";

describe("Burrow same-origin transport diagnostic route", () => {
  it("returns a request ID and timestamp without making external requests", async () => {
    const requestId = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("5354d2ec-0f83-4b91-8d89-1a6fc0f78c6b");

    const response = await POST();
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-rescora-route-reached")).toBe("true");
    expect(response.headers.get("x-rescora-rpc-attempted")).toBe("false");
    expect(body).toEqual({
      requestId: "5354d2ec-0f83-4b91-8d89-1a6fc0f78c6b",
      serverTimestamp: expect.any(String),
    });
    expect(Number.isNaN(Date.parse((body as { serverTimestamp: string }).serverTimestamp))).toBe(
      false,
    );
    expect(requestId).toHaveBeenCalledOnce();
    requestId.mockRestore();
  });
});
