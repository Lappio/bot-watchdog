import { afterEach, describe, it, expect, vi } from "vitest";
import { api, ApiError, TOKEN_KEY } from "@/lib/api";
afterEach(() => vi.unstubAllGlobals());
describe("API client", () => {
  it("uses same-origin API URLs and a bearer header", async () => {
    localStorage.setItem(TOKEN_KEY, "test-token");
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ tasks: [] })));
    vi.stubGlobal("fetch", fetch);
    expect(await api("/tasks")).toEqual({ tasks: [] });
    expect(fetch.mock.calls[0][0]).toBe("/api/tasks");
    expect(fetch.mock.calls[0][1].headers.get("Authorization")).toBe(
      "Bearer test-token",
    );
  });
  it("parses structured errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              error: { code: "validation_error", message: "Invalid schedule" },
            }),
            { status: 400 },
          ),
        ),
    );
    const error = await api("/tasks").catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: "validation_error",
      message: "Invalid schedule",
    });
  });
  it("clears the token and notifies the UI on 401", async () => {
    localStorage.setItem(TOKEN_KEY, "expired");
    const listener = vi.fn();
    window.addEventListener("bw-unauthorized", listener);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              error: { code: "unauthorized", message: "Unauthorized" },
            }),
            { status: 401 },
          ),
        ),
    );
    await expect(api("/stats")).rejects.toMatchObject({ status: 401 });
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener("bw-unauthorized", listener);
  });
  it("returns snippet text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("POST /hb/<YOUR_PING_TOKEN>")),
    );
    expect(await api("/tasks/id/snippet", {}, true)).toBe(
      "POST /hb/<YOUR_PING_TOKEN>",
    );
  });
});
