import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeIndependentPck } from "./extraction-fixtures.js";
import {
  createListingFixtures,
  createPckFixture,
  listingFixtureContent,
  type ListingFixtures,
} from "./listing-fixtures.js";

/**
 * Independently expected extracted file. Bytes come from authored fixture
 * content, never from runtime output or a successful listing.
 */
export interface AuthoredExtractionFile {
  /** Destination-relative path with forward slashes. */
  readonly relative: string;
  readonly bytes: Buffer;
  readonly size: number;
  readonly sha256: string;
}

export const authoredExtractionFile = (
  relative: string,
  content: string | Uint8Array,
): AuthoredExtractionFile => {
  const bytes = Buffer.from(content);
  return {
    relative,
    bytes,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};

/**
 * Files extracted from the listing fixture source directory and from one-member
 * ZIP/APK/XAPK pack sources. APK and XAPK loaders map `assets/` entries to
 * `res://`, so the destination-relative names are the authored names.
 */
export const listingExtractionFiles: readonly AuthoredExtractionFile[] = [
  authoredExtractionFile("project.godot", listingFixtureContent.project),
  authoredExtractionFile("hello 空间.txt", listingFixtureContent.text),
];

export interface FixtureProfile {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Disposable runtime profile used only to author PCK fixtures. This mirrors the
 * accepted listing fixture-generation pattern: every profile path is redirected
 * away from the ambient user profile.
 */
export async function createFixtureProfile(root: string, name: string): Promise<FixtureProfile> {
  const profile = path.join(root, "setup-profiles", name);
  const values = {
    APPDATA: path.join(profile, "appdata"),
    LOCALAPPDATA: path.join(profile, "localappdata"),
    USERPROFILE: path.join(profile, "userprofile"),
    HOME: path.join(profile, "home"),
    TEMP: path.join(profile, "temp"),
    TMP: path.join(profile, "temp"),
    GDRE_PLUGIN_CACHE_DIR: path.join(profile, "plugin-cache"),
  };
  const cwd = path.join(profile, "cwd");
  await Promise.all([...Object.values(values), cwd].map((directory) => mkdir(directory, { recursive: true })));
  const configDirectory = path.join(values.APPDATA, "Godot", "app_userdata", "Godot RE Tools");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(path.join(configDirectory, "gdre_settings.cfg"), [
    "[General]",
    "download_plugins=false",
    "execute_visual_shader_node_scripts=false",
    "delete_auto_converted_files=false",
    "force_single_threaded=false",
    "[Recovery]",
    "clear_output_dir_except_git_before_full_recovery=false",
    "git/create_git_repo=false",
    "git/add_imports_to_git_repo=false",
    "[CSharp]",
    "compile_after_decompile=false",
    "verify_nuget_package_is_from_nuget_org=false",
    "automatically_search_workshop_dependencies=false",
    "copy_out_of_tree_references=false",
    "",
  ].join("\n"), { flag: "wx" });
  return {
    cwd,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      ...values,
    },
  };
}

/** Author an unencrypted PCK fixture through the fixed runtime create command. */
export async function createRuntimePck(options: {
  readonly fixtureRoot: string;
  readonly name: string;
  readonly runtimeExecutable: string;
  readonly sourceDirectory: string;
  readonly format: 0 | 1 | 2 | 3 | 4;
}): Promise<string> {
  const output = path.join(options.fixtureRoot, `${options.name}.pck`);
  const profile = await createFixtureProfile(options.fixtureRoot, `create-${options.name}`);
  await createPckFixture({
    runtimeExecutable: options.runtimeExecutable,
    sourceDirectory: options.sourceDirectory,
    output,
    format: options.format,
    cwd: profile.cwd,
    env: profile.env,
  });
  return output;
}

/** Author a format-2 PCK with independent bytes and no runtime involvement. */
export async function authorFormat2Pck(
  filename: string,
  files: readonly { readonly relative: string; readonly bytes: Buffer }[],
): Promise<readonly AuthoredExtractionFile[]> {
  await writeIndependentPck(filename, files);
  return files.map((file) => authoredExtractionFile(file.relative, file.bytes));
}

/**
 * Corrupt the last payload byte of the first independently authored format-2
 * member while leaving the header, member directory, offsets/sizes, and all
 * original MD5 entries intact.
 *
 * The package still loads and lists successfully, but default extraction
 * checksum verification must detect the payload/header-MD5 mismatch.
 */
export async function corruptFirstPckPayloadByte(filename: string): Promise<void> {
  const bytes = await readFile(filename);
  const filesStart = Number(bytes.readBigUInt64LE(24));
  const entriesStart = 4 * 5 + 4 + 8 + 64 + 4;
  const storedNameLength = bytes.readUInt32LE(entriesStart);
  const offsetPosition = entriesStart + 4 + storedNameLength;
  const sizePosition = offsetPosition + 8;
  const offset = Number(bytes.readBigUInt64LE(offsetPosition));
  const size = Number(bytes.readBigUInt64LE(sizePosition));
  if (size < 1) throw new Error(`authored PCK member has no payload bytes: ${filename}`);
  const target = filesStart + offset + size - 1;
  const current = bytes[target];
  if (current === undefined) throw new Error(`authored PCK payload offset is outside the file: ${filename}`);
  bytes[target] = current ^ 0xff;
  await writeFile(filename, bytes);
}

export interface ExtractionInputMatrix {
  readonly fixtureRoot: string;
  readonly listing: ListingFixtures;
  readonly pcks: ReadonlyMap<0 | 1 | 2 | 3 | 4, string>;
  readonly markedDirectory: string;
  readonly appResourcesBundle: string;
  readonly appResourcesPck: string;
  readonly appFallbackBundle: string;
  readonly appFallbackPck: string;
  readonly sidecarExecutable: string;
  readonly sidecarPck: string;
}

/**
 * Build every assigned input form. Each container is authored locally; expected
 * member bytes remain `listingExtractionFiles` and are never derived from
 * listing or extraction output.
 */
export async function createExtractionInputMatrix(options: {
  readonly fixtureRoot: string;
  readonly runtimeExecutable: string;
}): Promise<ExtractionInputMatrix> {
  await mkdir(options.fixtureRoot, { recursive: true });
  const listing = await createListingFixtures(options.fixtureRoot);
  const pcks = new Map<0 | 1 | 2 | 3 | 4, string>();
  for (const format of [0, 1, 2, 3, 4] as const) {
    pcks.set(format, await createRuntimePck({
      fixtureRoot: options.fixtureRoot,
      name: `format-${String(format)}`,
      runtimeExecutable: options.runtimeExecutable,
      sourceDirectory: listing.sourceDirectory,
      format,
    }));
  }

  const markedDirectory = path.join(options.fixtureRoot, "marked source");
  await cp(listing.sourceDirectory, markedDirectory, { recursive: true });

  const appResourcesBundle = path.join(options.fixtureRoot, "resources bundle.app");
  const appResourcesPck = path.join(appResourcesBundle, "Contents", "Resources", "resources.pck");
  await mkdir(path.dirname(appResourcesPck), { recursive: true });
  await cp(pcks.get(2)!, appResourcesPck);

  const appFallbackBundle = path.join(options.fixtureRoot, "fallback bundle.app");
  const appFallbackPck = path.join(appFallbackBundle, "fallback.pck");
  await mkdir(appFallbackBundle, { recursive: true });
  await cp(pcks.get(2)!, appFallbackPck);

  const sidecarExecutable = path.join(options.fixtureRoot, "sidecar 空间.exe");
  const sidecarPck = path.join(options.fixtureRoot, "sidecar 空间.pck");
  await cp(process.execPath, sidecarExecutable);
  await cp(pcks.get(2)!, sidecarPck);

  return {
    fixtureRoot: options.fixtureRoot,
    listing,
    pcks,
    markedDirectory,
    appResourcesBundle,
    appResourcesPck,
    appFallbackBundle,
    appFallbackPck,
    sidecarExecutable,
    sidecarPck,
  };
}
