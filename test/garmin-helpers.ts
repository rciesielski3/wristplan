import { deflateRawSync } from "node:zlib";
import { vi } from "vitest";
import { createGarminClient } from "../src/modules/garmin/index";

export const KEY = "fake-garmin-test-key";
export const JWT = ["fakeheader", "fakepayload", "fakesignature"].join(".");
export const JWT2 = ["fakeheader", "fakepayload2", "fakesignature2"].join(".");
export const BASE = "https://personal.connectapi.garmin.com";
export const TOKEN_URL = `${BASE}/personalapitoken-service/personal-api/personal-api-key/token`;

export const reply = (status: number, body: BodyInit | null, headers?: Record<string, string>) =>
  new Response(body, { status, ...(headers ? { headers } : {}) });

export const activity = {
  activityId: 1001,
  activityName: "Morning Run",
  activityType: { typeKey: "running", typeId: 1, parentTypeId: 17 },
  startTimeGMT: "2026-03-01 06:30:00",
  startTimeLocal: "2026-03-01 07:30:00",
  duration: 1800.5,
  distance: 5000.25,
  ownerId: 42,
  ownerFullName: "Test Person",
  ownerProfileImageUrlLarge: "https://example.invalid/img.png",
  startLatitude: 1.5,
  startLongitude: 2.5,
  averageHR: 140,
};

export const setup = (responses: Response[] = [], now: () => number = () => 0) => {
  const fetchMock = vi.fn<typeof fetch>();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  const client = createGarminClient({ apiKey: KEY, fetch: fetchMock, now });
  return { client, fetchMock };
};

export const callOf = (fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, i: number) => {
  const [url, init] = fetchMock.mock.calls[i] ?? [];
  return {
    url: String(url),
    method: init?.method,
    headers: new Headers(init?.headers),
  };
};

const u16 = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};

export interface ZipOptions {
  name?: string;
  method?: 0 | 8 | 9;
  flags?: number;
  entries?: number;
  rawData?: Buffer;
  declaredSize?: number;
  comment?: string;
}

export const buildZip = (content: Buffer, o: ZipOptions = {}): Uint8Array => {
  const name = Buffer.from(o.name ?? "1001_ACTIVITY.fit");
  const method = o.method ?? 8;
  const data = o.rawData ?? (method === 8 ? deflateRawSync(content) : content);
  const size = o.declaredSize ?? content.length;
  const flags = o.flags ?? 0;
  const local = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(flags),
    u16(method),
    u32(0),
    u32(0),
    u32(data.length),
    u32(size),
    u16(name.length),
    u16(0),
    name,
    data,
  ]);
  const central = Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(flags),
    u16(method),
    u32(0),
    u32(0),
    u32(data.length),
    u32(size),
    u16(name.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    name,
  ]);
  const comment = Buffer.from(o.comment ?? "");
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(o.entries ?? 1),
    u16(o.entries ?? 1),
    u32(central.length),
    u32(local.length),
    u16(comment.length),
    comment,
  ]);
  return new Uint8Array(Buffer.concat([local, central, eocd]));
};
