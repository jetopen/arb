import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { requireCron } from "../api-auth";

const req = (auth?: string) =>
  new NextRequest("http://localhost/api/arb/scan", auth ? { headers: { authorization: auth } } : undefined);

describe("requireCron", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("fails CLOSED (401) when CRON_SECRET is unset in production", () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(requireCron(req())?.status).toBe(401);
  });

  it("stays OPEN (null) when CRON_SECRET is unset in dev", () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(requireCron(req())).toBeNull();
  });

  it("allows a request bearing the correct secret", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("NODE_ENV", "production");
    expect(requireCron(req("Bearer s3cret"))).toBeNull();
  });

  it("denies (401) a wrong or missing bearer when the secret is set", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("NODE_ENV", "production");
    expect(requireCron(req("Bearer nope"))?.status).toBe(401);
    expect(requireCron(req())?.status).toBe(401);
  });
});
