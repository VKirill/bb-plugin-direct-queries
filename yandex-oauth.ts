export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<HttpResponse>;

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export class YandexOAuthError extends Error {
  readonly code: string;
  readonly description?: string;

  constructor(code: string, description?: string) {
    super(description ? `${code}: ${description}` : code);
    this.name = "YandexOAuthError";
    this.code = code;
    this.description = description;
  }
}

const AUTHORIZE_URL = "https://oauth.yandex.ru/authorize";
const TOKEN_URL = "https://oauth.yandex.ru/token";
const INFO_URL = "https://login.yandex.ru/info";
const DAY_MS = 24 * 60 * 60 * 1000;

export function authorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  scope?: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    force_confirm: "yes",
  });
  if (opts.scope) params.set("scope", opts.scope);
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function tokenRequest(
  params: Record<string, string>,
  fetch: FetchFn,
  now: () => number,
): Promise<OAuthTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // non-JSON error page
  }
  if (res.status !== 200 || typeof data.access_token !== "string") {
    throw new YandexOAuthError(
      String(data.error ?? `http_${res.status}`),
      typeof data.error_description === "string" ? data.error_description : text.slice(0, 300),
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: String(data.refresh_token ?? ""),
    expiresAt: now() + Number(data.expires_in ?? 0) * 1000,
  };
}

export function exchangeCode(opts: {
  code: string;
  clientId: string;
  clientSecret: string;
  fetch: FetchFn;
  now?: () => number;
}): Promise<OAuthTokens> {
  return tokenRequest(
    {
      grant_type: "authorization_code",
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    },
    opts.fetch,
    opts.now ?? Date.now,
  );
}

export function refreshToken(opts: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetch: FetchFn;
  now?: () => number;
}): Promise<OAuthTokens> {
  return tokenRequest(
    {
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    },
    opts.fetch,
    opts.now ?? Date.now,
  );
}

export async function userInfo(opts: {
  accessToken: string;
  fetch: FetchFn;
}): Promise<{ login: string; id: string; displayName?: string }> {
  const res = await opts.fetch(`${INFO_URL}?format=json`, {
    headers: { Authorization: `OAuth ${opts.accessToken}` },
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // non-JSON error page
  }
  if (res.status !== 200) {
    throw new YandexOAuthError(
      String(data.error ?? `http_${res.status}`),
      typeof data.error_description === "string" ? data.error_description : text.slice(0, 300),
    );
  }
  return {
    login: String(data.login ?? ""),
    id: String(data.id ?? ""),
    displayName: (data.display_name ?? data.real_name) as string | undefined,
  };
}

export async function ensureFresh(
  token: OAuthTokens,
  now: number,
  refresher: (token: OAuthTokens) => Promise<OAuthTokens>,
): Promise<OAuthTokens> {
  return token.expiresAt - now < DAY_MS ? refresher(token) : token;
}
