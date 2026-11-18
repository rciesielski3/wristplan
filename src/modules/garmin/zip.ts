import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;
const ZIP64_MARK = 0xffffffff;

export class ZipError extends Error {
  override readonly name = "ZipError";
}

const fail = (reason: string): never => {
  throw new ZipError(reason);
};

export function extractSingleFit(zip: Uint8Array, maxBytes: number): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u16 = (o: number) =>
    o + 2 <= zip.length ? view.getUint16(o, true) : fail("truncated zip");
  const u32 = (o: number) =>
    o + 4 <= zip.length ? view.getUint32(o, true) : fail("truncated zip");

  let eocd = -1;
  const lowest = Math.max(0, zip.length - EOCD_MIN - MAX_COMMENT);
  for (let o = zip.length - EOCD_MIN; o >= lowest; o--) {
    if (u32(o) === EOCD_SIG) {
      eocd = o;
      break;
    }
  }
  if (eocd < 0) fail("end of central directory not found");
  if (u16(eocd + 10) !== 1) fail("zip must contain exactly one entry");

  const cen = u32(eocd + 16);
  if (u32(cen) !== CEN_SIG) fail("bad central directory");
  const flags = u16(cen + 8);
  const method = u16(cen + 10);
  const compressedSize = u32(cen + 20);
  const size = u32(cen + 24);
  const nameLength = u16(cen + 28);
  const localOffset = u32(cen + 42);

  if (compressedSize === ZIP64_MARK || size === ZIP64_MARK || localOffset === ZIP64_MARK) {
    fail("zip64 is not supported");
  }
  if (flags & 1) fail("encrypted entries are not supported");
  if (method !== 0 && method !== 8) fail("unsupported compression method");
  if (size > maxBytes) fail("entry exceeds size limit");

  if (cen + 46 + nameLength > zip.length) fail("truncated zip");
  const name = Buffer.from(zip.subarray(cen + 46, cen + 46 + nameLength)).toString("utf8");
  if (!/^[\w.-]+\.fit$/i.test(name) || name.includes("..")) fail("unexpected entry name");

  if (u32(localOffset) !== LOC_SIG) fail("bad local header");
  const start = localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28);
  if (start + compressedSize > zip.length) fail("truncated zip");
  const data = zip.subarray(start, start + compressedSize);

  let out: Uint8Array;
  if (method === 0) {
    out = data;
  } else {
    try {
      out = inflateRawSync(data, { maxOutputLength: Math.max(1, size) });
    } catch {
      return fail("invalid deflate data");
    }
  }
  if (out.length !== size) fail("entry size mismatch");
  return new Uint8Array(out);
}
