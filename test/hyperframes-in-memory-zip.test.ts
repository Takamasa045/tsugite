import { deflateRawSync } from "node:zlib";

import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import InMemoryZip, {
  MAX_UNCOMPRESSED_ENTRY_BYTES,
  inflateZipEntry,
  listZipEntries
} from "../backends/hyperframes/in-memory-zip/index.mjs";

const ARCHIVE_ENTRY_TIME = new Date(1980, 0, 1, 0, 0, 0, 0);

function writeU16(buf, offset, value) {
  buf.writeUInt16LE(value, offset);
}

function writeU32(buf, offset, value) {
  buf.writeUInt32LE(value, offset);
}

function nthAscii(buf, text, n) {
  const needle = Buffer.from(text);
  let from = 0;
  for (let i = 0; i <= n; i += 1) {
    const index = buf.indexOf(needle, from);
    if (index < 0) throw new Error(`missing ${text}`);
    if (i === n) return index;
    from = index + 1;
  }
  throw new Error(`missing ${text}`);
}

function forgeDeflatedZip({ name, uncompressed, uncompressedSize, crc }) {
  const payload = deflateRawSync(uncompressed);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30 + nameBuf.length + payload.length);
  writeU32(local, 0, 0x04034b50);
  writeU16(local, 4, 20);
  writeU16(local, 8, 8);
  writeU32(local, 14, crc);
  writeU32(local, 18, payload.length);
  writeU32(local, 22, uncompressedSize);
  writeU16(local, 26, nameBuf.length);
  nameBuf.copy(local, 30);
  payload.copy(local, 30 + nameBuf.length);
  const cd = Buffer.alloc(46 + nameBuf.length);
  writeU32(cd, 0, 0x02014b50);
  writeU16(cd, 4, 20);
  writeU16(cd, 6, 20);
  writeU16(cd, 10, 8);
  writeU32(cd, 16, crc);
  writeU32(cd, 20, payload.length);
  writeU32(cd, 24, uncompressedSize);
  writeU16(cd, 28, nameBuf.length);
  nameBuf.copy(cd, 46);
  const eocd = Buffer.alloc(22);
  writeU32(eocd, 0, 0x06054b50);
  writeU16(eocd, 8, 1);
  writeU16(eocd, 10, 1);
  writeU32(eocd, 12, cd.length);
  writeU32(eocd, 16, local.length);
  return Buffer.concat([local, cd, eocd]);
}

describe("hyperframes in-memory zip", () => {
  it("roundtrips publish addFile/getEntries/header.time/toBuffer metadata", () => {
    const archive = new InMemoryZip();
    archive.addFile("index.html", "<div>caption</div>");
    archive.addFile("a/data.bin", Buffer.from([1, 2, 3, 4]));
    archive.addFile("__proto__", "not-polluting");
    for (const entry of archive.getEntries()) {
      entry.header.time = ARCHIVE_ENTRY_TIME;
    }
    expect(archive.getEntries().map((entry) => entry.entryName)).toEqual([
      "index.html",
      "a/data.bin",
      "__proto__"
    ]);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "not-polluting")).toBe(false);

    const buffer = archive.toBuffer();
    const listed = listZipEntries(buffer);
    for (const entry of listed) {
      expect(entry.dosDate).toBe((1 << 5) | 1);
      expect(entry.dosTime).toBe(0);
    }
    const independent = unzipSync(new Uint8Array(buffer), {
      filter: (file) => file.name === "index.html" || file.name === "a/data.bin"
    });
    expect(Buffer.from(independent["index.html"]).toString("utf8")).toBe("<div>caption</div>");
    expect(Buffer.from(independent["a/data.bin"]).equals(Buffer.from([1, 2, 3, 4]))).toBe(true);

    const reread = new InMemoryZip(buffer);
    const names = reread.getEntries().map((entry) => entry.entryName).sort();
    expect(names).toEqual(["__proto__", "a/data.bin", "index.html"]);
    expect(
      reread.getEntries().find((entry) => entry.entryName === "index.html")?.getData().toString("utf8")
    ).toBe("<div>caption</div>");
    expect(
      reread.getEntries().find((entry) => entry.entryName === "__proto__")?.getData().toString("utf8")
    ).toBe("not-polluting");
  });

  it("inflates a chosen .lottie json entry and leaves an unselected large entry unread", () => {
    const source = new InMemoryZip();
    source.addFile("padding.bin", Buffer.alloc(512 * 1024, 7));
    source.addFile("animations/main.json", JSON.stringify({ layers: [], w: 1920 }));
    const buffer = source.toBuffer();
    const crcOffset = nthAscii(buffer, "padding.bin", 1) - 30;
    buffer.writeUInt32LE(0, crcOffset);
    const listed = listZipEntries(buffer);
    expect(listed.map((entry) => entry.name).sort()).toEqual([
      "animations/main.json",
      "padding.bin"
    ]);
    const lottie = new InMemoryZip(buffer);
    const json = lottie.getEntries().find((entry) => entry.entryName === "animations/main.json");
    expect(JSON.parse(json.getData().toString("utf8"))).toMatchObject({ w: 1920, layers: [] });
    expect(() => lottie.getEntries().find((entry) => entry.entryName === "padding.bin")?.getData())
      .toThrow(/CRC mismatch/);
  });

  it("rejects a forged small central-directory size when DEFLATE expands past the cap", () => {
    const expanded = Buffer.alloc(MAX_UNCOMPRESSED_ENTRY_BYTES + 1, 0);
    const zip = forgeDeflatedZip({
      name: "bomb.bin",
      uncompressed: expanded,
      uncompressedSize: 1,
      crc: 0
    });
    const listed = listZipEntries(zip);
    expect(listed[0]?.uncompressedSize).toBe(1);
    expect(() => inflateZipEntry(zip, listed[0])).toThrow(/inflate exceeded limit|uncompressed size mismatch/);
  });

  it("rejects CRC corruption, encryption, ZIP64, and truncated central directories", () => {
    const archive = new InMemoryZip();
    archive.addFile("ok.txt", "hello");
    const valid = archive.toBuffer();
    const corrupt = Buffer.from(valid);
    corrupt.writeUInt32LE(0xdeadbeef, nthAscii(corrupt, "ok.txt", 1) - 30);
    expect(() => new InMemoryZip(corrupt).getEntries()[0].getData()).toThrow(/CRC mismatch/);

    const encrypted = Buffer.from(valid);
    encrypted.writeUInt16LE(1, nthAscii(encrypted, "ok.txt", 1) - 38);
    expect(() => listZipEntries(encrypted)).toThrow(/encryption/);

    const zip64 = Buffer.from(valid);
    zip64.writeUInt32LE(0xffffffff, nthAscii(zip64, "ok.txt", 1) - 22);
    expect(() => listZipEntries(zip64)).toThrow(/ZIP64/);

    expect(() => listZipEntries(valid.subarray(0, valid.length - 10))).toThrow(/central directory|end-of-central-directory/);
  });

  it("sets EFS on local and central headers so Japanese UTF-8 paths survive independent unzip", () => {
    const FLAG_EFS = 0x0800;
    const archive = new InMemoryZip();
    archive.addFile("素材/字幕.txt", "日本語キャプション");
    const buffer = archive.toBuffer();
    const nameBytes = Buffer.from("素材/字幕.txt", "utf8");
    const localName = buffer.indexOf(nameBytes);
    const centralName = buffer.indexOf(nameBytes, localName + 1);
    expect(localName).toBeGreaterThanOrEqual(0);
    expect(centralName).toBeGreaterThan(localName);
    expect(buffer.readUInt16LE(localName - 24) & FLAG_EFS).toBe(FLAG_EFS);
    expect(buffer.readUInt16LE(centralName - 38) & FLAG_EFS).toBe(FLAG_EFS);
    const independent = unzipSync(new Uint8Array(buffer));
    expect(Object.keys(independent)).toContain("素材/字幕.txt");
    expect(Buffer.from(independent["素材/字幕.txt"]).toString("utf8")).toBe("日本語キャプション");
  });

  it("does not expose filesystem extraction APIs", () => {
    const archive = new InMemoryZip();
    expect(archive.extractAllTo).toBeUndefined();
    expect(archive.extractAllToAsync).toBeUndefined();
    expect(archive.extractEntryTo).toBeUndefined();
  });
});
