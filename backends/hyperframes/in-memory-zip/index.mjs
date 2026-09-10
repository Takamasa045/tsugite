/**
 * In-memory ZIP adapter for the pinned HyperFrames CLI.
 * Publish path: addFile / getEntries / header.time / toBuffer.
 * Read path: list central-directory names, inflate a chosen entry only
 * with Node zlib's bounded inflateRawSync. No filesystem extraction API.
 */
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export const MAX_ZIP_ENTRIES = 1024;
export const MAX_UNCOMPRESSED_ENTRY_BYTES = 8 * 1024 * 1024;
export const MAX_COMPRESSED_ENTRY_BYTES = 8 * 1024 * 1024;

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_EXTRA = 0x0001;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;

function toUint8(content) {
  if (content instanceof Uint8Array) return content;
  if (Buffer.isBuffer(content)) return new Uint8Array(content);
  if (typeof content === "string") return new TextEncoder().encode(content);
  throw new TypeError("ZIP entry content must be a string or Uint8Array");
}

function toBuffer(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readU16(buf, offset) {
  return buf.readUInt16LE(offset);
}

function readU32(buf, offset) {
  return buf.readUInt32LE(offset);
}

function crcOf(buf) {
  return crc32(buf) >>> 0;
}

function findEocdOffset(buf) {
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let offset = buf.length - 22; offset >= min; offset -= 1) {
    if (readU32(buf, offset) !== EOCD_SIG) continue;
    const commentLen = readU16(buf, offset + 20);
    if (offset + 22 + commentLen === buf.length) return offset;
  }
  throw new Error("ZIP end-of-central-directory not found");
}

function extraHasZip64(extra) {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const header = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    if (offset + 4 + size > extra.length) throw new Error("ZIP extra field truncated");
    if (header === ZIP64_EXTRA) return true;
    offset += 4 + size;
  }
  return false;
}

export function listZipEntries(buf) {
  if (!Buffer.isBuffer(buf)) buf = toBuffer(toUint8(buf));
  const eocd = findEocdOffset(buf);
  const disk = readU16(buf, eocd + 4);
  const cdDisk = readU16(buf, eocd + 6);
  const diskEntries = readU16(buf, eocd + 8);
  const count = readU16(buf, eocd + 10);
  const cdSize = readU32(buf, eocd + 12);
  const cdOffset = readU32(buf, eocd + 16);
  if (disk !== 0 || cdDisk !== 0) throw new Error("ZIP multi-disk archives are unsupported");
  if (diskEntries !== count) throw new Error("ZIP central directory disk count mismatch");
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are unsupported");
  }
  if (count > MAX_ZIP_ENTRIES) throw new Error("ZIP entry count exceeds limit");
  if (cdOffset + cdSize !== eocd) throw new Error("ZIP central directory bounds mismatch");
  const listed = [];
  let offset = cdOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buf.length) throw new Error("ZIP central directory truncated");
    if (readU32(buf, offset) !== CD_SIG) throw new Error("ZIP central directory signature mismatch");
    const flags = readU16(buf, offset + 8);
    const method = readU16(buf, offset + 10);
    const dosTime = readU16(buf, offset + 12);
    const dosDate = readU16(buf, offset + 14);
    const crc = readU32(buf, offset + 16);
    const compressedSize = readU32(buf, offset + 20);
    const uncompressedSize = readU32(buf, offset + 24);
    const nameLen = readU16(buf, offset + 28);
    const extraLen = readU16(buf, offset + 30);
    const commentLen = readU16(buf, offset + 32);
    const startDisk = readU16(buf, offset + 34);
    const localOffset = readU32(buf, offset + 42);
    const nameStart = offset + 46;
    const extraStart = nameStart + nameLen;
    const extraEnd = extraStart + extraLen;
    const recordEnd = extraEnd + commentLen;
    if (recordEnd > buf.length) throw new Error("ZIP central directory truncated");
    if (flags & FLAG_ENCRYPTED) throw new Error("ZIP encryption is unsupported");
    if (startDisk !== 0) throw new Error("ZIP multi-disk archives are unsupported");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("ZIP64 archives are unsupported");
    }
    const extra = buf.subarray(extraStart, extraEnd);
    if (extraHasZip64(extra)) throw new Error("ZIP64 archives are unsupported");
    const name = buf.subarray(nameStart, extraStart).toString("utf8");
    offset = recordEnd;
    if (name.endsWith("/")) continue;
    listed.push({
      name,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      dosTime,
      dosDate
    });
  }
  if (offset !== eocd) throw new Error("ZIP central directory truncated");
  return listed;
}

function boundedInflateRaw(payload, maxOutputLength) {
  try {
    return inflateRawSync(payload, { maxOutputLength });
  } catch (error) {
    if (error && (error.code === "ERR_BUFFER_TOO_LARGE" || /larger than/i.test(error.message))) {
      throw new Error("ZIP inflate exceeded limit");
    }
    throw new Error("ZIP inflate failed");
  }
}

export function inflateZipEntry(buf, meta) {
  if (meta.uncompressedSize > MAX_UNCOMPRESSED_ENTRY_BYTES) {
    throw new Error("ZIP entry uncompressed size exceeds limit");
  }
  if (meta.compressedSize > MAX_COMPRESSED_ENTRY_BYTES) {
    throw new Error("ZIP entry compressed size exceeds limit");
  }
  if (meta.localOffset + 30 > buf.length) throw new Error("ZIP local header truncated");
  if (readU32(buf, meta.localOffset) !== LOCAL_SIG) {
    throw new Error("ZIP local header signature mismatch");
  }
  const localFlags = readU16(buf, meta.localOffset + 6);
  const localMethod = readU16(buf, meta.localOffset + 8);
  if (localFlags & FLAG_ENCRYPTED) throw new Error("ZIP encryption is unsupported");
  if (localMethod !== meta.method) throw new Error("ZIP local method mismatch");
  const nameLen = readU16(buf, meta.localOffset + 26);
  const extraLen = readU16(buf, meta.localOffset + 28);
  const extraStart = meta.localOffset + 30 + nameLen;
  const dataStart = extraStart + extraLen;
  if (dataStart > buf.length) throw new Error("ZIP local header truncated");
  if (extraHasZip64(buf.subarray(extraStart, dataStart))) {
    throw new Error("ZIP64 archives are unsupported");
  }
  const dataEnd = dataStart + meta.compressedSize;
  if (dataEnd > buf.length) throw new Error("ZIP entry data truncated");
  if (!(localFlags & FLAG_DATA_DESCRIPTOR)) {
    const localCompressed = readU32(buf, meta.localOffset + 18);
    const localUncompressed = readU32(buf, meta.localOffset + 22);
    if (localCompressed !== meta.compressedSize || localUncompressed !== meta.uncompressedSize) {
      throw new Error("ZIP local size mismatch");
    }
  }
  const payload = buf.subarray(dataStart, dataEnd);
  let out;
  if (meta.method === 0) {
    if (payload.length > MAX_UNCOMPRESSED_ENTRY_BYTES) {
      throw new Error("ZIP stored entry exceeds limit");
    }
    out = Buffer.from(payload);
  } else if (meta.method === 8) {
    const cap = Math.min(MAX_UNCOMPRESSED_ENTRY_BYTES, meta.uncompressedSize);
    out = boundedInflateRaw(payload, Math.max(cap, 1));
  } else {
    throw new Error(`Unsupported ZIP compression method ${meta.method}`);
  }
  if (out.length !== meta.uncompressedSize) {
    throw new Error("ZIP uncompressed size mismatch");
  }
  if (crcOf(out) !== meta.crc) throw new Error("ZIP CRC mismatch");
  return out;
}

function dosFromDate(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  return { dosDate, dosTime };
}

function writeU16(parts, value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value);
  parts.push(buf);
}

function writeU32(parts, value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  parts.push(buf);
}

function createHeader(time) {
  return { time: time ?? null };
}

function encodeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const file = entry.data;
    const deflated = deflateRawSync(file);
    const useStore = deflated.length >= file.length;
    const payload = useStore ? file : deflated;
    const method = useStore ? 0 : 8;
    const time = entry.header.time instanceof Date && !Number.isNaN(entry.header.time.getTime())
      ? entry.header.time
      : new Date(1980, 0, 1);
    const { dosDate, dosTime } = dosFromDate(time);
    const crc = crcOf(file);
    const local = [];
    writeU32(local, LOCAL_SIG);
    writeU16(local, 20);
    writeU16(local, FLAG_UTF8);
    writeU16(local, method);
    writeU16(local, dosTime);
    writeU16(local, dosDate);
    writeU32(local, crc);
    writeU32(local, payload.length);
    writeU32(local, file.length);
    writeU16(local, name.length);
    writeU16(local, 0);
    local.push(name, payload);
    const localBuf = Buffer.concat(local);
    locals.push(localBuf);
    const cd = [];
    writeU32(cd, CD_SIG);
    writeU16(cd, 20);
    writeU16(cd, 20);
    writeU16(cd, FLAG_UTF8);
    writeU16(cd, method);
    writeU16(cd, dosTime);
    writeU16(cd, dosDate);
    writeU32(cd, crc);
    writeU32(cd, payload.length);
    writeU32(cd, file.length);
    writeU16(cd, name.length);
    writeU16(cd, 0);
    writeU16(cd, 0);
    writeU16(cd, 0);
    writeU16(cd, 0);
    writeU32(cd, 0);
    writeU32(cd, offset);
    cd.push(name);
    central.push(Buffer.concat(cd));
    offset += localBuf.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = [];
  writeU32(eocd, EOCD_SIG);
  writeU16(eocd, 0);
  writeU16(eocd, 0);
  writeU16(eocd, entries.length);
  writeU16(eocd, entries.length);
  writeU32(eocd, cdBuf.length);
  writeU32(eocd, offset);
  writeU16(eocd, 0);
  return Buffer.concat([...locals, cdBuf, ...eocd]);
}

export default class InMemoryZip {
  constructor(input) {
    this._entries = [];
    this._source = null;
    if (input == null) return;
    const bytes = Buffer.isBuffer(input) ? input : toBuffer(toUint8(input));
    this._source = bytes;
    for (const meta of listZipEntries(bytes)) {
      this._entries.push({
        name: meta.name,
        header: createHeader(null),
        data: null,
        meta
      });
    }
  }

  addFile(name, content) {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("ZIP entry name must be a non-empty string");
    }
    this._entries.push({
      name,
      header: createHeader(null),
      data: toBuffer(toUint8(content)),
      meta: null
    });
  }

  getEntries() {
    return this._entries.map((entry) => ({
      entryName: entry.name,
      header: entry.header,
      getData: () => this._dataFor(entry)
    }));
  }

  _dataFor(entry) {
    if (entry.data) return Buffer.from(entry.data);
    if (!this._source || !entry.meta) {
      throw new Error(`ZIP entry ${entry.name} has no data`);
    }
    entry.data = inflateZipEntry(this._source, entry.meta);
    return Buffer.from(entry.data);
  }

  toBuffer() {
    const materialized = this._entries.map((entry) => ({
      name: entry.name,
      header: entry.header,
      data: this._dataFor(entry)
    }));
    return encodeZip(materialized);
  }
}
