import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { canMaintainEnvironment, findEnvironmentUpdate } from "./environment-maintenance";

afterEach(() => vi.unstubAllGlobals());

describe("environment maintenance access", () => {
  it("requires a connected authenticated session with operate permission", () => {
    const session = {
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "session",
      },
      scopes: [AuthOrchestrationOperateScope],
    };
    expect(canMaintainEnvironment(session, true)).toBe(true);
    expect(canMaintainEnvironment(session, false)).toBe(false);
    expect(canMaintainEnvironment({ ...session, authenticated: false }, true)).toBe(false);
    expect(canMaintainEnvironment({ ...session, scopes: [] }, true)).toBe(false);
    const { scopes: _, ...legacy } = session;
    expect(canMaintainEnvironment(legacy, true)).toBe(false);
    expect(canMaintainEnvironment(null, true)).toBe(false);
  });

  it.each([
    { permissions: ["environment:maintain"], expected: true },
    { permissions: ["providers:manage"], expected: false },
    { permissions: [], expected: false },
  ] as const)(
    "honors exact permissions over legacy scopes: $permissions",
    ({ permissions, expected }) => {
      expect(
        canMaintainEnvironment(
          {
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: [],
              sessionMethods: [],
              sessionCookieName: "session",
              serverUpdateScope: "environment:maintain",
            },
            scopes: ["orchestration:operate"],
            permissions,
          },
          true,
        ),
      ).toBe(expected);
    },
  );
});

describe("environment release checks", () => {
  const signal = new AbortController().signal;
  const distTags = (tags: Record<string, string>) =>
    vi.fn(async (url: string) =>
      url === "https://registry.npmjs.org/-/package/t3/dist-tags"
        ? Response.json(tags)
        : new Response(null, { status: 404 }),
    );

  it("offers the newest release on the host's own channel", async () => {
    vi.stubGlobal(
      "fetch",
      distTags({
        latest: "1.0.0",
        nightly: "1.0.0-nightly.20260924.2",
        preview: "1.0.0-preview.20260924.3",
      }),
    );
    expect(await findEnvironmentUpdate("0.9.0", signal)).toBe("1.0.0");
    expect(await findEnvironmentUpdate("1.0.0-nightly.20260923.1", signal)).toBe(
      "1.0.0-nightly.20260924.2",
    );
    expect(await findEnvironmentUpdate("1.0.0-nightly.20260924.2", signal)).toBeNull();
    expect(await findEnvironmentUpdate("1.0.0-preview.20260923.1", signal)).toBe(
      "1.0.0-preview.20260924.3",
    );
  });

  it("reports failed checks instead of claiming the server is current", async () => {
    for (const status of [403, 429]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
      await expect(findEnvironmentUpdate("1.0.0", signal)).rejects.toThrow(String(status));
    }
    vi.stubGlobal("fetch", distTags({ latest: "1.0.0", nightly: "1.0.0" }));
    await expect(findEnvironmentUpdate("1.0.0-nightly.20260923.1", signal)).rejects.toThrow(
      "No nightly release",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(["invalid"])));
    await expect(findEnvironmentUpdate("1.0.0", signal)).rejects.toThrow();
  });
});
