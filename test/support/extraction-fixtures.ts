import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Independently authored extraction fixture.
 *
 * The PCK byte writer is implemented from the documented/independently read
 * fixed PCK format-2 layout. GDRE is never used to author the package or to
 * derive the expected member names, bytes, or hashes.
 */
export interface ExtractionFixtureMember {
  /** Complete runtime-visible member name. */
  readonly name: string;
  /** Destination-relative path with forward slashes. */
  readonly relative: string;
  readonly bytes: Buffer;
  readonly size: number;
  readonly sha256: string;
  /** PCK header MD5 entry, computed from the authored bytes. */
  readonly md5: Buffer;
}

export interface ExtractionFixture {
  readonly root: string;
  /** Absolute PCK path. */
  readonly pck: string;
  /** Workspace-relative PCK path used by the caller. */
  readonly relativePck: string;
  readonly members: readonly ExtractionFixtureMember[];
  readonly directories: readonly string[];
}

export const extractionFixtureContent = {
  project:
    "; Engine configuration file.\n" +
    "; Independently authored extraction fixture.\n" +
    "config_version=5\n" +
    "\n" +
    "[application]\n" +
    "\n" +
    'config/name="独立 extraction fixture"\n' +
    'run/main_scene="res://scenes/main.tscn"\n',
  unicodeText:
    "独立 authored extraction fixture\r\n" +
    "第一行：hello 空间\r\n" +
    "second line 😀\n",
  binary: Buffer.from([
    0x00, 0x01, 0x02, 0x03, 0x7f, 0x80, 0xfe, 0xff,
    0x0a, 0x0d, 0x00, 0x47, 0x44, 0x52, 0x45, 0x20,
    0x4e, 0x55, 0x4c, 0x00, 0x9f, 0x92, 0x96, 0x00,
  ]),
} as const;

const member = (relative: string, bytes: Buffer): ExtractionFixtureMember => ({
  name: `res://${relative}`,
  relative,
  bytes,
  size: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  md5: createHash("md5").update(bytes).digest(),
});

export const extractionFixtureMembers: readonly ExtractionFixtureMember[] = [
  member("project.godot", Buffer.from(extractionFixtureContent.project, "utf8")),
  member("文本/hello 空间.txt", Buffer.from(extractionFixtureContent.unicodeText, "utf8")),
  member("data/nested.bin", Buffer.from(extractionFixtureContent.binary)),
];

export const extractionFixtureDirectories = ["data", "文本"] as const;

const align = (value: number, boundary: number): number =>
  value + ((boundary - (value % boundary)) % boundary);

const PCK_HEADER_MAGIC = 0x43504447;
const PCK_FORMAT_V2 = 2;

interface EncodedMember {
  readonly name: Buffer;
  readonly storedNameLength: number;
  readonly offset: number;
  readonly data: Buffer;
  readonly md5: Buffer;
}

/**
 * Write an unencrypted PCK format-2 package with engine version 4.4.0.
 *
 * Layout (little-endian), matching the fixed reader's accepted format:
 * magic, format, engine major/minor/patch, flags, absolute file base, 64
 * reserved bytes, file count, then path/offset/size/md5/flags entries.
 * Member payloads are 32-byte aligned and the header is padded to 32 bytes.
 */
export async function writeIndependentPck(
  filename: string,
  members: readonly { readonly relative: string; readonly bytes: Buffer }[],
): Promise<void> {
  const encoded: EncodedMember[] = [];
  let dataOffset = 0;
  for (const entry of members) {
    const name = Buffer.from(entry.relative, "utf8");
    encoded.push({
      name,
      storedNameLength: align(name.byteLength, 4),
      offset: dataOffset,
      data: Buffer.from(entry.bytes),
      md5: createHash("md5").update(entry.bytes).digest(),
    });
    dataOffset = align(dataOffset + entry.bytes.byteLength, 32);
  }

  const headerWithoutEntries = 4 * 5 + 4 + 8 + 64 + 4;
  const entriesLength = encoded.reduce(
    (total, entry) => total + 4 + entry.storedNameLength + 8 + 8 + 16 + 4,
    0,
  );
  const headerSize = headerWithoutEntries + entriesLength;
  const filesStart = align(headerSize, 32);

  const header = Buffer.alloc(filesStart);
  let cursor = 0;
  header.writeUInt32LE(PCK_HEADER_MAGIC, cursor); cursor += 4;
  header.writeUInt32LE(PCK_FORMAT_V2, cursor); cursor += 4;
  header.writeUInt32LE(4, cursor); cursor += 4; // engine major
  header.writeUInt32LE(4, cursor); cursor += 4; // engine minor
  header.writeUInt32LE(0, cursor); cursor += 4; // engine patch
  header.writeUInt32LE(0, cursor); cursor += 4; // pack flags (unencrypted)
  header.writeBigUInt64LE(BigInt(filesStart), cursor); cursor += 8; // absolute file base
  cursor += 64; // reserved
  header.writeUInt32LE(encoded.length, cursor); cursor += 4;
  for (const entry of encoded) {
    header.writeUInt32LE(entry.storedNameLength, cursor); cursor += 4;
    entry.name.copy(header, cursor); cursor += entry.storedNameLength;
    header.writeBigUInt64LE(BigInt(entry.offset), cursor); cursor += 8;
    header.writeBigUInt64LE(BigInt(entry.data.byteLength), cursor); cursor += 8;
    entry.md5.copy(header, cursor); cursor += 16;
    header.writeUInt32LE(0, cursor); cursor += 4; // unencrypted, present
  }
  if (cursor !== headerSize) throw new Error(`independent PCK header size mismatch: ${String(cursor)} != ${String(headerSize)}`);

  const payload: Buffer[] = [header];
  for (const entry of encoded) {
    payload.push(entry.data);
    const padding = align(entry.data.byteLength, 32) - entry.data.byteLength;
    if (padding > 0) payload.push(Buffer.alloc(padding));
  }
  const endMagic = Buffer.alloc(4);
  endMagic.writeUInt32LE(PCK_HEADER_MAGIC, 0);
  payload.push(endMagic);

  await writeFile(filename, Buffer.concat(payload), { flag: "wx" });
}

/** Author a fresh PCK fixture below the caller-selected root. */
export async function createExtractionFixture(root: string): Promise<ExtractionFixture> {
  await mkdir(root, { recursive: true });
  const pck = path.join(root, "authored 空间.pck");
  await writeIndependentPck(pck, extractionFixtureMembers);
  return {
    root,
    pck,
    relativePck: `fixtures/${path.basename(pck)}`,
    members: extractionFixtureMembers,
    directories: extractionFixtureDirectories,
  };
}
