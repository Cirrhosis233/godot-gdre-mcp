import { createReadStream } from "node:fs";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";
import { pathIdentity } from "./paths.js";
import { boundedUtf8 } from "./text.js";
import type {
  EvaluationResult,
  ExpectedLoad,
  ListFilesSemanticData,
  ProcessObservation,
  RetainedStreamEvidence,
} from "./types.js";

export const LIST_FILES_RULE = "gdre-list-files-v1";
const MAX_SCAN_CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_MEMBER_NAME_BYTES = 2_048;
const INLINE_STDOUT_REF = "inline://stdout";

const HResultDiagnostic = {
  first: 'ERROR: Condition "res != ((HRESULT)0L)" is true.',
  second: "   at: OS_Windows::get_system_dir (platform\\windows\\os_windows.cpp:2511)",
} as const;
const HResultReturningDiagnostic = {
  first: 'ERROR: Condition "res != ((HRESULT)0L)" is true. Returning: String()',
  second: HResultDiagnostic.second,
} as const;
const ApkDiagnostic = {
  first: "WARNING: Could not retrieve version string from AndroidManifest.xml",
  second: "   at: APKArchive::try_open_pack (modules\\gdsdecomp\\utility\\file_access_apk.cpp:421)",
} as const;
const AppBundleFallbackDiagnostic = {
  first: "WARNING: Contents/Resources directory not found in .app bundle, searching for pck in root...",
  second: "   at: GDRESettings::sort_and_validate_pck_files (modules\\gdsdecomp\\utility\\gdre_settings.cpp:516)",
} as const;
const SidecarDiagnostic = {
  prefix: "WARNING: Could not find embedded pck in EXE, found pck file, loading from: ",
  second: "   at: GDRESettings::sort_and_validate_pck_files (modules\\gdsdecomp\\utility\\gdre_settings.cpp:613)",
} as const;
const XapkMetadataDiagnostic = {
  first: "ERROR: File does not exist in zip archive: AndroidManifest.xml",
  rest: [
    "   at: ZIPReader::read_file (modules\\zip\\zip_reader.cpp:99)",
    "WARNING: Failed to parse base APK manifest!",
    "   at: APKArchive::handle_xapk (modules\\gdsdecomp\\utility\\file_access_apk.cpp:307)",
  ],
} as const;

interface ScanResult {
  readonly complete: boolean;
  readonly utf8Valid: boolean;
  readonly interrupted: boolean;
  readonly error: string | null;
  readonly evidencePath: string;
}

export interface ObservedOpening {
  readonly kind: "file" | "directory";
  readonly path: string;
}
type OpeningObservation = ObservedOpening;

/** Parse one anchored runtime opening line, shared by listing and extraction. */
export function parseOpeningLine(line: string): ObservedOpening | null {
  const opening = /^(Opening file|Opening directory): (.+)$/u.exec(line);
  if (opening === null || opening[2] === undefined) return null;
  return {
    kind: opening[1] === "Opening directory" ? "directory" : "file",
    path: opening[2],
  };
}

interface ListingParse {
  readonly inputCount: number;
  readonly bannerCount: number;
  readonly openingCount: number;
  readonly openings: readonly OpeningObservation[];
  readonly contentsCount: number;
  readonly memberCount: number;
  readonly members: readonly string[];
  readonly sampleOmitted: boolean;
  readonly totalFiles: number | null;
  readonly error: string | null;
  readonly malformed: string | null;
  readonly complete: boolean;
}

class ListingParser {
  private phase: "header" | "members" | "after-blank" | "done" = "header";
  private inputCount = 0;
  private bannerCount = 0;
  private openingCount = 0;
  private readonly openings: OpeningObservation[] = [];
  private openingOverflow = false;
  private contentsCount = 0;
  private memberCount = 0;
  private readonly members: string[] = [];
  private sampleOmitted = false;
  private totalFiles: number | null = null;
  private error: string | null = null;
  private malformed: string | null = null;

  public constructor(
    private readonly maxOpenings: number,
    private readonly retainAllMembers = false,
  ) {}

  public push(line: string): void {
    if (this.phase === "done") {
      if (line.length > 0) this.markMalformed("output contained data after the Total files footer");
      return;
    }

    if (this.phase === "header") {
      this.pushHeader(line);
      return;
    }
    if (this.phase === "members") {
      this.pushMember(line);
      return;
    }
    this.pushFooter(line);
  }

  public finish(): ListingParse {
    if (this.phase === "members") this.markMalformed("Contents section has no Total files footer");
    if (this.phase === "after-blank") this.markMalformed("Total files footer is missing");
    if (this.openingOverflow) this.markMalformed("listing contained too many opening headers");
    return {
      inputCount: this.inputCount,
      bannerCount: this.bannerCount,
      openingCount: this.openingCount,
      openings: [...this.openings],
      contentsCount: this.contentsCount,
      memberCount: this.memberCount,
      members: [...this.members],
      sampleOmitted: this.sampleOmitted,
      totalFiles: this.totalFiles,
      error: this.error,
      malformed: this.malformed,
      complete:
        this.error === null &&
        this.malformed === null &&
        this.inputCount === 1 &&
        this.bannerCount === 1 &&
        this.openingCount > 0 &&
        this.contentsCount === 1 &&
        this.totalFiles !== null &&
        this.phase === "done",
    };
  }

  private pushHeader(line: string): void {
    if (line.length === 0) return;
    if (/^Error(?:\s|:)/iu.test(line)) {
      this.markError(line);
      return;
    }
    if (line.startsWith("Input files:")) {
      if (line.slice("Input files:".length).trim().length === 0) {
        this.markMalformed("Input files marker had no value");
      } else if (this.inputCount > 0) {
        this.markMalformed("Input files marker appeared more than once");
      } else {
        this.inputCount += 1;
      }
      return;
    }
    if (/^GDRE Tools v\S+$/u.test(line)) {
      this.bannerCount += 1;
      if (this.bannerCount > 1) this.markMalformed("GDRE version banner appeared more than once");
      return;
    }
    if (/^Windows .+$/u.test(line)) return;
    const opening = parseOpeningLine(line);
    if (opening !== null) {
      this.openingCount += 1;
      if (this.openings.length < this.maxOpenings) {
        this.openings.push(opening);
      } else {
        this.openingOverflow = true;
      }
      return;
    }
    if (line === "Contents:") {
      this.contentsCount += 1;
      if (this.contentsCount > 1) {
        this.markMalformed("Contents marker appeared more than once");
      } else {
        this.phase = "members";
      }
      return;
    }
    this.markMalformed(`unexpected listing header line: ${boundedUtf8(line, "listing line")}`);
  }

  private pushMember(line: string): void {
    if (line.length === 0) {
      this.phase = "after-blank";
      return;
    }
    if (/^Error(?:\s|:)/iu.test(line)) {
      this.markError(line);
      return;
    }
    if (!line.startsWith("res://") || line.length === "res://".length) {
      this.markMalformed("Contents section contained a non-member line");
      return;
    }
    this.memberCount += 1;
    if (this.retainAllMembers) {
      // Complete extraction preflight retention is not a public listing sample:
      // keep every parser-valid member name. The 16 KiB line scanner remains
      // the only stream-level bound, and mapping validates Windows safety later.
      this.members.push(line);
      if (Buffer.byteLength(line, "utf8") > MAX_MEMBER_NAME_BYTES) this.sampleOmitted = true;
      return;
    }
    if (Buffer.byteLength(line, "utf8") > MAX_MEMBER_NAME_BYTES) {
      // Keep counting the complete stream, but never irreversibly cut a member
      // name before the caller can redact a sensitive value from its sample.
      this.sampleOmitted = true;
      return;
    }
    if (this.members.length < 32) this.members.push(line);
  }

  private pushFooter(line: string): void {
    if (line.length === 0) {
      this.markMalformed("Contents section contained more than one blank separator");
      return;
    }
    const match = /^Total files: ([0-9]+)$/u.exec(line);
    if (match === null || match[1] === undefined) {
      if (/^Error(?:\s|:)/iu.test(line)) this.markError(line);
      else this.markMalformed("listing footer was not exactly Total files: N");
      return;
    }
    const parsed = Number(match[1]);
    if (!Number.isSafeInteger(parsed)) {
      this.markMalformed("listing footer count was not a safe integer");
      return;
    }
    if (this.totalFiles !== null) {
      this.markMalformed("Total files footer appeared more than once");
      return;
    }
    this.totalFiles = parsed;
    this.phase = "done";
  }

  private markError(line: string): void {
    this.error ??= boundedUtf8(line, "listing load error");
  }

  private markMalformed(message: string): void {
    this.malformed ??= boundedUtf8(message, "ambiguous listing output");
  }
}

class BoundedLineScanner {
  private readonly parts: string[] = [];
  private bytes = 0;
  private discarding = false;
  private overlong = false;

  public constructor(private readonly onLine: (line: string) => void) {}

  public push(text: string): void {
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      const end = newline === -1 ? text.length : newline;
      this.pushPart(text.slice(start, end));
      if (newline === -1) return;
      this.emit();
      start = end + 1;
    }
  }

  public finish(): void {
    if (this.bytes > 0 || this.parts.length > 0 || this.discarding) this.emit();
  }

  public get overlongLine(): boolean {
    return this.overlong;
  }

  private pushPart(part: string): void {
    if (part.length === 0) return;
    this.bytes += Buffer.byteLength(part, "utf8");
    if (this.discarding) return;
    if (this.bytes > MAX_LINE_BYTES) {
      this.discarding = true;
      this.overlong = true;
      this.parts.length = 0;
      return;
    }
    this.parts.push(part);
  }

  private emit(): void {
    if (this.discarding) {
      this.reset();
      return;
    }
    let line = this.parts.join("");
    if (line.endsWith("\r")) line = line.slice(0, -1);
    this.onLine(line);
    this.reset();
  }

  private reset(): void {
    this.parts.length = 0;
    this.bytes = 0;
    this.discarding = false;
  }
}

const interrupted = (observation: ProcessObservation): boolean =>
  observation.abortSignal?.aborted === true ||
  (observation.deadlineMono !== undefined && performance.now() >= observation.deadlineMono);

async function* inlineChunks(value: string): AsyncGenerator<Buffer> {
  let chunk = "";
  let bytes = 0;
  for (const character of value) {
    const nextBytes = Buffer.byteLength(character, "utf8");
    if (chunk.length > 0 && bytes + nextBytes > MAX_SCAN_CHUNK_BYTES) {
      yield Buffer.from(chunk, "utf8");
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += nextBytes;
  }
  if (chunk.length > 0) yield Buffer.from(chunk, "utf8");
}

const sourcePath = (evidence: RetainedStreamEvidence | undefined): string | null =>
  evidence?.rawPath ?? evidence?.textPath ?? null;

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const scanStream = async (
  value: string,
  evidence: RetainedStreamEvidence | undefined,
  truncated: boolean,
  observation: ProcessObservation,
  onLine: (line: string) => void,
): Promise<ScanResult> => {
  const evidencePath = sourcePath(evidence) ?? (evidence === undefined ? INLINE_STDOUT_REF : "");
  let complete = evidence?.complete ?? !truncated;
  let utf8Valid = evidence?.utf8Valid ?? true;
  let error: string | null = null;
  let interruptedScan = interrupted(observation);
  let redactionFailed = false;
  const redactLine = (line: string): string => {
    if (observation.redactText === undefined) return line;
    try {
      return observation.redactText(line);
    } catch {
      redactionFailed = true;
      return "";
    }
  };
  const boundedReadError = (cause: unknown, fallback: string): string => {
    const raw = errorMessage(cause);
    if (observation.redactText === undefined) return boundedUtf8(raw, fallback);
    try {
      return boundedUtf8(observation.redactText(raw), fallback);
    } catch {
      redactionFailed = true;
      return fallback;
    }
  };
  const scanner = new BoundedLineScanner((line) => onLine(redactLine(line)));
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const forgivingDecoder = new TextDecoder("utf-8");
  let decoderFailed = false;
  let stream: AsyncIterable<Buffer>;

  if (interruptedScan) {
    return { complete: false, utf8Valid, interrupted: true, error: null, evidencePath };
  }

  const persistedPath = sourcePath(evidence);
  if (persistedPath !== null) {
    try {
      stream = createReadStream(persistedPath, { highWaterMark: MAX_SCAN_CHUNK_BYTES });
    } catch (cause) {
      return {
        complete: false,
        utf8Valid,
        interrupted: false,
        error: boundedReadError(cause, "retained stream could not be opened"),
        evidencePath,
      };
    }
  } else if (evidence !== undefined) {
    complete = false;
    return { complete, utf8Valid, interrupted: false, error: "retained stream evidence has no path", evidencePath };
  } else {
    stream = inlineChunks(value);
  }

  try {
    for await (const chunk of stream) {
      if (interrupted(observation)) {
        interruptedScan = true;
        complete = false;
        break;
      }
      const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let decoded: string;
      if (decoderFailed) {
        decoded = forgivingDecoder.decode(raw, { stream: true });
      } else {
        try {
          decoded = decoder.decode(raw, { stream: true });
        } catch {
          utf8Valid = false;
          decoderFailed = true;
          decoded = forgivingDecoder.decode(raw, { stream: true });
        }
      }
      scanner.push(decoded);
      if (interrupted(observation)) {
        interruptedScan = true;
        complete = false;
        break;
      }
    }
    if (!interruptedScan) {
      if (decoderFailed) {
        scanner.push(forgivingDecoder.decode());
      } else {
        try {
          scanner.push(decoder.decode());
        } catch {
          utf8Valid = false;
          scanner.push(forgivingDecoder.decode());
        }
      }
      scanner.finish();
    }
  } catch (cause) {
    complete = false;
    error = boundedReadError(cause, "retained stream could not be read");
  }

  if (scanner.overlongLine) {
    complete = false;
    error ??= "listing contained an overlong line";
  }
  if (redactionFailed) {
    complete = false;
    error ??= "stream redaction failed";
  }
  if (interruptedScan) error ??= observation.abortSignal?.aborted === true ? "listing scan was cancelled" : "listing scan deadline expired";
  return { complete, utf8Valid, interrupted: interruptedScan, error, evidencePath };
};

interface DiagnosticResult {
  readonly error: string | null;
  readonly unknown: string | null;
  readonly evidence: readonly string[];
}

class StderrDiagnostics {
  private pending: { readonly first: string; readonly rest: readonly string[]; readonly label: string } | null = null;
  private error: string | null = null;
  private unknown: string | null = null;
  private readonly evidence: string[] = [];

  public push(line: string): void {
    if (this.pending !== null) {
      const expected = this.pending.rest[0];
      if (expected !== undefined && line === expected) {
        this.pending = {
          ...this.pending,
          rest: this.pending.rest.slice(1),
        };
        if (this.pending.rest.length === 0) {
          this.addEvidence(`${this.pending.label}: ${this.pending.first}`);
          this.pending = null;
        }
        return;
      }
      this.flushPending();
    }

    if (line === HResultDiagnostic.first) {
      this.beginPair(HResultDiagnostic.first, HResultDiagnostic.second, "Accepted known diagnostic");
      return;
    }
    if (line === HResultReturningDiagnostic.first) {
      this.beginPair(HResultReturningDiagnostic.first, HResultReturningDiagnostic.second, "Accepted known diagnostic");
      return;
    }
    if (line === ApkDiagnostic.first) {
      this.beginPair(ApkDiagnostic.first, ApkDiagnostic.second, "Accepted known diagnostic");
      return;
    }
    if (line === AppBundleFallbackDiagnostic.first) {
      this.beginPair(AppBundleFallbackDiagnostic.first, AppBundleFallbackDiagnostic.second, "Accepted known fallback diagnostic");
      return;
    }
    if (line.startsWith(SidecarDiagnostic.prefix) && line.slice(SidecarDiagnostic.prefix.length).length > 0) {
      this.pending = {
        first: line,
        rest: [SidecarDiagnostic.second],
        label: "Accepted known sidecar diagnostic",
      };
      return;
    }
    if (line === XapkMetadataDiagnostic.first) {
      this.pending = {
        first: XapkMetadataDiagnostic.first,
        rest: XapkMetadataDiagnostic.rest,
        label: "Accepted known optional XAPK metadata diagnostic",
      };
      return;
    }
    if (line.length === 0) return;
    if (/^(?:ERROR|FATAL|Error)(?:\s|:)/iu.test(line)) {
      this.error ??= boundedUtf8(line, "listing load error");
    } else {
      this.unknown ??= boundedUtf8(line, "unclassified stderr diagnostic");
    }
  }

  public finish(): DiagnosticResult {
    this.flushPending();
    return { error: this.error, unknown: this.unknown, evidence: [...this.evidence] };
  }

  private beginPair(first: string, second: string, label: string): void {
    this.pending = { first, rest: [second], label };
  }

  private flushPending(): void {
    if (this.pending !== null) {
      this.error ??= boundedUtf8(`incomplete known stderr diagnostic: ${this.pending.first}`, "incomplete known stderr diagnostic");
      this.pending = null;
    }
  }

  private addEvidence(value: string): void {
    if (this.evidence.length < 32) this.evidence.push(boundedUtf8(value, "stderr diagnostic"));
  }
}

const failed = (summary: string, evidence: readonly string[] = []): EvaluationResult<ListFilesSemanticData> => ({
  status: "failed",
  rule: LIST_FILES_RULE,
  summary,
  evidence: evidence.slice(0, 32),
  data: null,
});

const unknown = (summary: string, evidence: readonly string[] = []): EvaluationResult<ListFilesSemanticData> => ({
  status: "unknown",
  rule: LIST_FILES_RULE,
  summary,
  evidence: evidence.slice(0, 32),
  data: null,
});

const expectedLoadToken = (
  load: Pick<ExpectedLoad, "path" | "kind">,
  redactText?: (text: string) => string,
): string | null => {
  try {
    const path = redactText === undefined ? load.path : redactText(load.path);
    return `${load.kind ?? "file"}:${pathIdentity(path)}`;
  } catch {
    return null;
  }
};

const observedLoadToken = (load: ObservedOpening): string => `${load.kind}:${pathIdentity(load.path)}`;

/**
 * Compare complete anchored opening evidence with the prepared load graph.
 * Listing and extraction share this exact normalization (including dependency
 * and directory forms).
 */
export function openingsMatchExpectedLoads(
  openings: readonly ObservedOpening[],
  expectedLoads: readonly ExpectedLoad[] | undefined,
  redactText?: (text: string) => string,
): boolean {
  if (expectedLoads === undefined) return true;
  const expected = expectedLoads.map((load) => expectedLoadToken(load, redactText));
  if (expected.some((value): value is null => value === null)) return false;
  const normalizedExpected = expected as string[];
  const observed = openings.map(observedLoadToken).sort();
  normalizedExpected.sort();
  return normalizedExpected.length === observed.length && normalizedExpected.every((value, index) => value === observed[index]);
}

const expectedLoadsMatch = (parsed: ListingParse, observation: ProcessObservation): boolean =>
  openingsMatchExpectedLoads(parsed.openings, observation.expectedLoads, observation.redactText);

export interface RetainedLineScan {
  readonly complete: boolean;
  readonly utf8Valid: boolean;
  readonly interrupted: boolean;
  readonly error: string | null;
  readonly evidencePath: string;
}

/**
 * Scan one complete retained text stream line by line. Extraction reuses this
 * scanner so its preflight and completion diagnostics are not a second parser.
 */
export async function scanRetainedTextLines(
  observation: ProcessObservation,
  value: string,
  evidence: RetainedStreamEvidence | undefined,
  truncated: boolean,
  onLine: (line: string) => void,
): Promise<RetainedLineScan> {
  return scanStream(value, evidence, truncated, observation, onLine);
}

export interface KnownStderrScan {
  readonly scan: RetainedLineScan;
  readonly diagnosticError: string | null;
  readonly unknown: string | null;
  readonly diagnosticEvidence: readonly string[];
}

/** Apply the accepted known-diagnostic classification to one retained stream. */
export async function scanKnownStderrDiagnostics(
  observation: ProcessObservation,
  value: string,
  evidence: RetainedStreamEvidence | undefined,
  truncated: boolean,
): Promise<KnownStderrScan> {
  const diagnostics = new StderrDiagnostics();
  const scan = await scanStream(value, evidence, truncated, observation, (line) => diagnostics.push(line));
  const result = diagnostics.finish();
  return {
    scan,
    diagnosticError: result.error,
    unknown: result.unknown,
    diagnosticEvidence: [...result.evidence],
  };
}

interface ListingEvidence {
  readonly status: "failed" | "unknown" | "succeeded";
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly parsed: ListingParse | null;
  readonly members: readonly string[];
  readonly stdoutPath: string;
}

/**
 * Shared complete-stream listing classification. Public listing evaluation uses
 * the bounded sample; extraction preflight requests complete member retention.
 */
const scanListingEvidence = async (
  observation: ProcessObservation,
  retainAllMembers: boolean,
): Promise<ListingEvidence> => {
  const parser = new ListingParser((observation.expectedLoads?.length ?? 64) + 1, retainAllMembers);
  const diagnosticsScanner = new StderrDiagnostics();
  const stdoutScan = await scanStream(
    observation.stdout,
    observation.stdoutEvidence,
    observation.stdoutTruncated,
    observation,
    (line) => parser.push(line),
  );
  const stderrScan = await scanStream(
    observation.stderr,
    observation.stderrEvidence,
    observation.stderrTruncated ?? false,
    observation,
    (line) => diagnosticsScanner.push(line),
  );
  if (stdoutScan.interrupted || stderrScan.interrupted) {
    return {
      status: "unknown",
      summary: stdoutScan.error ?? stderrScan.error ?? "GDRE listing evidence scan was cancelled or exceeded its deadline.",
      evidence: [stdoutScan.error, stderrScan.error].filter((value): value is string => value !== null),
      parsed: null,
      members: [],
      stdoutPath: stdoutScan.evidencePath,
    };
  }
  if (!stdoutScan.complete || !stderrScan.complete || !stdoutScan.utf8Valid || !stderrScan.utf8Valid) {
    return {
      status: "unknown",
      summary: "GDRE listing evidence was incomplete or not valid UTF-8; semantic success cannot be claimed.",
      evidence: [stdoutScan.error, stderrScan.error].filter((value): value is string => value !== null),
      parsed: null,
      members: [],
      stdoutPath: stdoutScan.evidencePath,
    };
  }

  const parsed = parser.finish();
  const diagnostics = diagnosticsScanner.finish();
  if (parsed.error !== null || diagnostics.error !== null) {
    return {
      status: "failed",
      summary: "GDRE reported a listing/load error; exit status alone cannot establish semantic success.",
      evidence: [parsed.error, diagnostics.error, ...diagnostics.evidence].filter((value): value is string => value !== null),
      parsed,
      members: [],
      stdoutPath: stdoutScan.evidencePath,
    };
  }
  if (observation.signal !== null || observation.exitCode !== 0) {
    return {
      status: "failed",
      summary: "GDRE listing did not finish with a natural exit code 0.",
      evidence: [`Observed exit code ${String(observation.exitCode)} and signal ${String(observation.signal)}.`],
      parsed,
      members: [],
      stdoutPath: stdoutScan.evidencePath,
    };
  }
  if (!parsed.complete || parsed.totalFiles === null) {
    return {
      status: "unknown",
      summary: "GDRE listing output did not contain one complete, unambiguous load/list section and footer.",
      evidence: [parsed.malformed ?? "required listing markers were not all observed"],
      parsed,
      members: [],
      stdoutPath: stdoutScan.evidencePath,
    };
  }
  if (!expectedLoadsMatch(parsed, observation)) {
    return {
      status: "unknown",
      summary: "GDRE opening paths did not corroborate the prepared listing input graph.",
      evidence: ["The complete stdout evidence opened a different set of prepared input or dependency paths."],
      parsed,
      members: [],
      stdoutPath: stdoutScan.evidencePath,
    };
  }
  if (parsed.totalFiles !== parsed.memberCount) {
    return {
      status: "failed",
      summary: "GDRE listing total did not match the number of parsed package members.",
      evidence: [`Footer reported ${String(parsed.totalFiles)} files but ${String(parsed.memberCount)} members were parsed.`],
      parsed,
      members: [],
      stdoutPath: stdoutScan.evidencePath,
    };
  }
  if (parsed.totalFiles === 0) {
    return {
      status: "unknown",
      summary: "GDRE reported an empty listing without an independently validated empty-input fixture.",
      evidence: ["A zero total and exit 0 are not sufficient evidence of a valid empty package."],
      parsed,
      members: [],
      stdoutPath: stdoutScan.evidencePath,
    };
  }
  if (diagnostics.unknown !== null) {
    return {
      status: "unknown",
      summary: "GDRE stderr contained an unclassified diagnostic; semantic success cannot be confirmed.",
      evidence: [diagnostics.unknown, ...diagnostics.evidence],
      parsed,
      members: [],
      stdoutPath: stdoutScan.evidencePath,
    };
  }
  if (Buffer.byteLength(stdoutScan.evidencePath, "utf8") > 2_048) {
    return {
      status: "unknown",
      summary: "Complete stdout listing evidence reference exceeded the bounded result path size.",
      evidence: [],
      parsed,
      members: [],
      stdoutPath: stdoutScan.evidencePath,
    };
  }
  if (retainAllMembers && parsed.members.length !== parsed.memberCount) {
    return {
      status: "unknown",
      summary: "The complete preflight member set could not be retained from the listing evidence.",
      evidence: [parsed.malformed ?? "retained member names did not match the parsed member count"],
      parsed,
      members: [],
      stdoutPath: stdoutScan.evidencePath,
    };
  }
  const evidence = [
    `Parsed ${String(parsed.memberCount)} res:// package members with a matching Total files footer.`,
    boundedUtf8(`Complete stdout listing evidence is retained at ${stdoutScan.evidencePath}.`, "stdout evidence"),
    ...(parsed.sampleOmitted && !retainAllMembers ? ["One or more oversized member names were omitted from the bounded sample; the complete listing remains in stdout evidence."] : []),
    ...diagnostics.evidence,
  ];
  return {
    status: "succeeded",
    summary: "GDRE listed files successfully.",
    evidence: evidence.slice(0, 32),
    parsed,
    members: [...parsed.members],
    stdoutPath: stdoutScan.evidencePath,
  };
};

/** Complete preflight member evidence for an extraction; never the public sample. */
export interface CompleteListingEvidence {
  readonly status: "failed" | "unknown" | "succeeded";
  readonly rule: string;
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly members: readonly string[];
  readonly totalFiles: number | null;
  readonly stdoutPath: string;
}

export async function collectCompleteListingMembers(
  observation: ProcessObservation,
): Promise<CompleteListingEvidence> {
  const evidence = await scanListingEvidence(observation, true);
  return {
    status: evidence.status,
    rule: LIST_FILES_RULE,
    summary: evidence.summary,
    evidence: [...evidence.evidence],
    members: [...evidence.members],
    totalFiles: evidence.parsed?.totalFiles ?? null,
    stdoutPath: evidence.stdoutPath,
  };
}

export async function evaluateListFiles(
  observation: ProcessObservation,
): Promise<EvaluationResult<ListFilesSemanticData>> {
  const evidence = await scanListingEvidence(observation, false);
  if (evidence.status === "failed") return failed(evidence.summary, evidence.evidence);
  if (evidence.status === "unknown" || evidence.parsed === null) return unknown(evidence.summary, evidence.evidence);
  const parsed = evidence.parsed;
  const memberCount = parsed.memberCount;
  return {
    status: "succeeded",
    rule: LIST_FILES_RULE,
    summary: "GDRE listed files successfully.",
    evidence: [...evidence.evidence],
    data: {
      totalFiles: parsed.totalFiles!,
      files: [...parsed.members],
      truncated: parsed.sampleOmitted || memberCount > parsed.members.length,
      stdoutPath: evidence.stdoutPath,
    },
  };
}
