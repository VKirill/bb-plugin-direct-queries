import { describe, it, expect } from "vitest";
import {
  authorizeUrl,
  exchangeCode,
  refreshToken,
  userInfo,
  ensureFresh,
  YandexOAuthError,
} from "../yandex-oauth.ts";
import type { HttpResponse, OAuthTokens } from "../yandex-oauth.ts";

interface RecordedCall {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
}

const res = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponse => ({
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

function fakeFetch(responses: HttpResponse[]) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetch = async (url: string, init?: RecordedCall["init"]): Promise<HttpResponse> => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch call");
    return next;
  };
  return { fetch, calls };
}

describe("authorizeUrl", () => {
  it("encodes client_id, redirect_uri, state and force_confirm", () => {
    const url = authorizeUrl({
      clientId: "cid-1",
      redirectUri: "https://app.example/cb?x=1&y=2",
      state: "s t&a",
    });
    expect(url.startsWith("https://oauth.yandex.ru/authorize?")).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe("cid-1");
    expect(params.get("redirect_uri")).toBe("https://app.example/cb?x=1&y=2");
    expect(params.get("state")).toBe("s t&a");
    expect(params.get("force_confirm")).toBe("yes");
    expect(params.get("scope")).toBeNull();
  });

  it("appends scope when given", () => {
    const params = new URL(
      authorizeUrl({ clientId: "c", redirectUri: "https://a/cb", state: "s", scope: "direct:read" }),
    ).searchParams;
    expect(params.get("scope")).toBe("direct:read");
  });
});

describe("exchangeCode", () => {
  it("posts grant_type=authorization_code and maps tokens", async () => {
    const { fetch, calls } = fakeFetch([
      res(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, token_type: "bearer" }),
    ]);
    const now = () => 1_000_000;
    const tokens = await exchangeCode({
      code: "the-code",
      clientId: "cid",
      clientSecret: "cs",
      fetch,
      now,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://oauth.yandex.ru/token");
    expect(calls[0].init?.method).toBe("POST");
    const form = new URLSearchParams(calls[0].init?.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("the-code");
    expect(form.get("client_id")).toBe("cid");
    expect(form.get("client_secret")).toBe("cs");
    expect(tokens).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: 1_000_000 + 3_600_000,
    });
  });

  it("throws YandexOAuthError on invalid_grant", async () => {
    const { fetch } = fakeFetch([
      res(400, { error: "invalid_grant", error_description: "Code has expired" }),
    ]);
    const err = await exchangeCode({
      code: "bad",
      clientId: "cid",
      clientSecret: "cs",
      fetch,
    }).then(
      () => {
        throw new Error("should have thrown");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(YandexOAuthError);
    expect((err as YandexOAuthError).code).toBe("invalid_grant");
    expect((err as YandexOAuthError).description).toBe("Code has expired");
  });
});

describe("refreshToken", () => {
  it("posts grant_type=refresh_token", async () => {
    const { fetch, calls } = fakeFetch([
      res(200, { access_token: "at-2", refresh_token: "rt-2", expires_in: 60 }),
    ]);
    const tokens = await refreshToken({
      refreshToken: "rt-1",
      clientId: "cid",
      clientSecret: "cs",
      fetch,
      now: () => 0,
    });
    const form = new URLSearchParams(calls[0].init?.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("rt-1");
    expect(tokens.accessToken).toBe("at-2");
    expect(tokens.expiresAt).toBe(60_000);
  });
});

describe("userInfo", () => {
  it("sends OAuth header and maps login/id/displayName", async () => {
    const { fetch, calls } = fakeFetch([
      res(200, { login: "user1", id: "42", display_name: "User One", real_name: "User Real" }),
    ]);
    const info = await userInfo({ accessToken: "tok", fetch });
    expect(calls[0].url).toBe("https://login.yandex.ru/info?format=json");
    expect(calls[0].init?.headers?.Authorization).toBe("OAuth tok");
    expect(info).toEqual({ login: "user1", id: "42", displayName: "User One" });
  });
});

describe("ensureFresh", () => {
  const token: OAuthTokens = { accessToken: "a", refreshToken: "r", expiresAt: 100_000_000 };
  const refreshed: OAuthTokens = { accessToken: "a2", refreshToken: "r2", expiresAt: 200_000_000 };

  it("refreshes when less than 24 h remain", async () => {
    const result = await ensureFresh(token, token.expiresAt - 1_000, async (t) => {
      expect(t).toBe(token);
      return refreshed;
    });
    expect(result).toBe(refreshed);
  });

  it("keeps the token when more than 24 h remain", async () => {
    const result = await ensureFresh(token, token.expiresAt - 25 * 60 * 60 * 1000, async () => {
      throw new Error("must not refresh");
    });
    expect(result).toBe(token);
  });
});
