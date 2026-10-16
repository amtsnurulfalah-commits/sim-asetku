import "server-only";
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { fail, type DrivePort, type DriveFile } from "./core";
const API = "https://www.googleapis.com/drive/v3/";
const FIELDS =
  "id,name,mimeType,parents,driveId,trashed,size,md5Checksum,capabilities(canAddChildren),appProperties";
export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  serviceAccount?: { client_email: string; private_key: string };
  maxBytes: number;
};
export function googleConfig(): GoogleConfig {
  const origin = process.env.APP_BASE_URL;
  if (!origin) fail("DRIVE_NOT_CONFIGURED");
  let sa: GoogleConfig["serviceAccount"];
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const x = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    if (typeof x.client_email !== "string" || typeof x.private_key !== "string")
      fail("DRIVE_NOT_CONFIGURED");
    sa = { client_email: x.client_email, private_key: x.private_key };
  }
  const maxBytes = Number(process.env.DRIVE_MAX_UPLOAD_BYTES ?? 20971520);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 104857600)
    fail("DRIVE_NOT_CONFIGURED");
  return {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
    redirectUri: origin + "/api/drive/oauth/callback",
    serviceAccount: sa,
    maxBytes,
  };
}
export class GoogleDrive implements DrivePort {
  constructor(
    private token: () => Promise<string>,
    private fetcher: typeof fetch = fetch,
  ) {}
  private async request(path: string, init: RequestInit = {}, raw = false) {
    const r = await this.fetcher(
      path.startsWith("https://") ? path : API + path,
      {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(45000),
        headers: {
          Authorization: "Bearer " + (await this.token()),
          ...init.headers,
        },
      },
    );
    if (!r.ok && r.status !== 308) {
      // Never return Google's body: it can contain file identifiers, credentials or account details.
      if (r.status === 403) {
        const message = await r.text();
        if (message.length <= 65536)
          try {
            const reasons =
              JSON.parse(message).error?.errors?.map(
                (e: { reason?: string }) => e.reason,
              ) ?? [];
            if (
              reasons.some((v: string) =>
                [
                  "storageQuotaExceeded",
                  "userRateLimitExceeded",
                  "rateLimitExceeded",
                  "dailyLimitExceeded",
                ].includes(v),
              )
            )
              fail("DRIVE_RATE_LIMIT", 429);
          } catch (e) {
            if (e instanceof Error && "code" in e) throw e;
          }
        fail("DRIVE_ACCESS_DENIED", 403);
      }
      if (r.status === 404 || r.status === 401)
        fail("DRIVE_ACCESS_DENIED", 403);
      if (r.status === 429) fail("DRIVE_RATE_LIMIT", 429);
      fail();
    }
    if (raw) return r;
    const bytes = await r.text();
    if (bytes.length > 1048576) fail();
    return bytes ? JSON.parse(bytes) : {};
  }
  async identity(): Promise<string> {
    const x = await this.request("about?fields=user(emailAddress)");
    if (typeof x.user?.emailAddress !== "string") fail();
    return x.user.emailAddress;
  }
  async get(id: string): Promise<DriveFile> {
    return this.request(
      `files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=${encodeURIComponent(FIELDS)}`,
    );
  }
  async list(
    parent: string,
    properties: Record<string, string> = {},
  ): Promise<DriveFile[]> {
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const q =
      `'${esc(parent)}' in parents and trashed=false` +
      Object.entries(properties)
        .map(
          ([k, v]) =>
            ` and appProperties has { key='${esc(k)}' and value='${esc(v)}' }`,
        )
        .join("");
    const all: DriveFile[] = [];
    let page = "";
    do {
      const x = await this.request(
        "files?" +
          new URLSearchParams({
            q,
            fields: `nextPageToken,files(${FIELDS})`,
            pageSize: "100",
            supportsAllDrives: "true",
            includeItemsFromAllDrives: "true",
            ...(page ? { pageToken: page } : {}),
          }),
      );
      all.push(...x.files);
      page = x.nextPageToken ?? "";
      if (all.length > 10000) fail("DRIVE_LIST_LIMIT", 409);
    } while (page);
    return all;
  }
  async folder(
    name: string,
    parent: string,
    properties: Record<string, string>,
  ): Promise<DriveFile> {
    return this.request(
      "files?supportsAllDrives=true&fields=" + encodeURIComponent(FIELDS),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          mimeType: "application/vnd.google-apps.folder",
          parents: [parent],
          appProperties: properties,
        }),
      },
    );
  }
  async probe(parent: string, marker: string) {
    const id = await this.generateId(),
      uri = await this.start(id, ".probe.txt", parent, "text/plain", 1, {
        inventoryProbe: marker,
      });
    const done = await this.chunk(uri, new Uint8Array([120]), 0, 1);
    if (done.fileId !== id) fail();
    return this.get(id);
  }
  async trash(id: string) {
    await this.request(
      `files/${encodeURIComponent(id)}?supportsAllDrives=true`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: '{"trashed":true}',
      },
    );
  }
  async generateId(): Promise<string> {
    const x = await this.request(
      "files/generateIds?count=1&space=drive&type=files",
    );
    return x.ids[0];
  }
  private uri(uri: string) {
    const u = new URL(uri);
    if (
      u.origin !== "https://www.googleapis.com" ||
      u.pathname !== "/upload/drive/v3/files" ||
      !u.searchParams.get("upload_id")
    )
      fail("INVALID_UPLOAD_SESSION");
    return u.href;
  }
  async start(
    id: string,
    name: string,
    parent: string,
    mime: string,
    size: number,
    properties: Record<string, string>,
  ) {
    const r: Response = await this.request(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": mime,
          "X-Upload-Content-Length": String(size),
        },
        body: JSON.stringify({
          id,
          name,
          parents: [parent],
          mimeType: mime,
          appProperties: properties,
        }),
      },
      true,
    );
    return this.uri(r.headers.get("Location") ?? "");
  }
  private async progress(uri: string, init: RequestInit, total: number) {
    const r: Response = await this.request(this.uri(uri), init, true);
    if (r.status === 308) {
      const range = r.headers.get("range"),
        m = range ? /^bytes=0-(\d+)$/.exec(range) : null;
      if (range && !m) fail();
      const offset = m ? Number(m[1]) + 1 : 0;
      if (offset > total) fail();
      return { offset };
    }
    const x = await r.json();
    if (typeof x.id !== "string") fail();
    return { offset: total, fileId: x.id as string };
  }
  chunk(uri: string, bytes: Uint8Array, offset: number, total: number) {
    return this.progress(
      uri,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Range": `bytes ${offset}-${offset + bytes.length - 1}/${total}`,
        },
        body: Buffer.from(bytes),
      },
      total,
    );
  }
  status(uri: string, total: number) {
    return this.progress(
      uri,
      {
        method: "PUT",
        headers: { "Content-Length": "0", "Content-Range": `bytes */${total}` },
      },
      total,
    );
  }
  async read(id: string, start: number, end: number): Promise<Uint8Array> {
    const r: Response = await this.request(
      `files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
      { headers: { Range: `bytes=${start}-${end}` } },
      true,
    );
    if (
      r.status !== 206 ||
      r.headers.get("content-range")?.split("/")[0] !== `bytes ${start}-${end}`
    )
      fail();
    const reader = r.body?.getReader();
    if (!reader) fail();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > end - start + 1) fail();
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    if (size !== end - start + 1) fail();
    return Buffer.concat(chunks);
  }
}
export function oauthClient(c: GoogleConfig) {
  if (!c.clientId || !c.clientSecret) fail("OAUTH_NOT_CONFIGURED");
  return new OAuth2Client(c.clientId, c.clientSecret, c.redirectUri);
}
export function serviceDrive(c: GoogleConfig) {
  if (!c.serviceAccount) fail("SERVICE_ACCOUNT_NOT_CONFIGURED");
  const auth = new GoogleAuth({
    credentials: c.serviceAccount,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  return new GoogleDrive(async () => {
    const t = await auth.getAccessToken();
    if (!t) fail();
    return t;
  });
}
export function oauthDrive(c: GoogleConfig, refreshToken: string) {
  const client = oauthClient(c);
  client.setCredentials({ refresh_token: refreshToken });
  return new GoogleDrive(async () => {
    const t = (await client.getAccessToken()).token;
    if (!t) fail("OAUTH_REAUTH_REQUIRED", 401);
    return t;
  });
}
