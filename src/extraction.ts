import { performance } from "node:perf_hooks";
import { joinPath, pathIdentity } from "./paths.js";
import {
  openingsMatchExpectedLoads,
  parseOpeningLine,
  scanKnownStderrDiagnostics,
  scanRetainedTextLines,
  type ObservedOpening,
} from "./listing.js";
import { mapExtractionMembers, ExtractionPathError, EXTRACTION_ROOT_LOG } from "./extraction-paths.js";
import { boundedUtf8 } from "./text.js";
import type {
  ArtifactInventory,
  ArtifactEntry,
} from "./artifacts.js";
import type {
  EvaluationResult,
  ExtractSemanticData,
  ProcessObservation,
} from "./types.js";

export const EXTRACT_RULE = "gdre-extract-v1";

const MAX_EVIDENCE = 32;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const NON_PCK_ARCHIVE = /\.(?:zip|apk|xapk)$/iu;
const REQUIRES_PCK_CHECK = /\.(?:pck|exe|app)$/iu;

/**
 * The fixed runtime's routine checksum pass returns ERR_SKIP without a summary
 * when no PCK/EXE PackInfo exists. That source-backed absence is acceptable
 * only for a corroborated graph made entirely of directory loads or recognized
 * non-PCK archives; any PCK/EXE/.app dependency or unknown file still requires
 * actual verification evidence.
 */
const graphSkipsPckChecks = (loads: ProcessObservation["expectedLoads"]): boolean => {
  if (loads === undefined || loads.length === 0) return false;
  return loads.every((load) => {
    if (REQUIRES_PCK_CHECK.test(load.path)) return false;
    if (load.kind === "directory") return true;
    return load.kind === "file" && NON_PCK_ARCHIVE.test(load.path);
  });
};

const bounded = (value: string, fallback = "extraction evidence"): string => boundedUtf8(value, fallback);

const interrupted = (observation: ProcessObservation): boolean =>
  observation.abortSignal?.aborted === true ||
  (observation.deadlineMono !== undefined && performance.now() >= observation.deadlineMono);

const result = (
  status: "failed" | "unknown",
  summary: string,
  evidence: readonly string[],
): EvaluationResult<ExtractSemanticData> => ({
  status,
  rule: EXTRACT_RULE,
  summary,
  evidence: evidence.slice(0, MAX_EVIDENCE).map((line) => bounded(line)),
  data: null,
});

const success = (
  summary: string,
  evidence: readonly string[],
  data: ExtractSemanticData,
): EvaluationResult<ExtractSemanticData> => ({
  status: "succeeded",
  rule: EXTRACT_RULE,
  summary,
  evidence: evidence.slice(0, MAX_EVIDENCE).map((line) => bounded(line)),
  data,
});

interface StdoutObservation {
  loadedMarkers: number;
  completionMarkers: number;
  extractedCounts: number[];
  extractedEvidence: string[];
  verificationEvidence: string[];
  verifiedFiles: number | null;
  skippedFiles: number | null;
  openings: ObservedOpening[];
  error: string | null;
  unknown: string | null;
}

const stripAnsi = (value: string): string =>
  value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "");

const inspectStdoutLine = (state: StdoutObservation, line: string): void => {
  for (const rawSegment of line.split("\r")) {
    const segment = stripAnsi(rawSegment).trim();
    if (segment.length === 0) continue;
    const opening = parseOpeningLine(segment);
    if (opening !== null) {
      state.openings.push(opening);
      continue;
    }
    if (/^(?:ERROR|FATAL|Error)(?:\s|:)/u.test(segment)) {
      state.error ??= bounded(segment, "extraction error");
      continue;
    }
    if (/^(?:WARNING|Warning)(?:\s|:)/u.test(segment)) {
      state.unknown ??= bounded(segment, "unclassified extraction diagnostic");
      continue;
    }
    if (/Checksum failed|MD5 mismatch|At least one error was detected|failed to open|failed to extract|Incorrect encryption key|Encryption error|File(?: write|Create|Access) error|(?:^|\s)Error(?:\s|:)/iu.test(segment)) {
      state.error ??= bounded(segment, "extraction error");
      continue;
    }
    if (/^Successfully loaded PCK!$/u.test(segment)) {
      state.loadedMarkers += 1;
      continue;
    }
    if (/^Extraction operation complete in [0-9]{2}m[0-9]{2}s$/u.test(segment)) {
      state.completionMarkers += 1;
      continue;
    }
    const extracted = /^Extracted ([0-9]+) files, no errors detected!$/u.exec(segment);
    if (extracted !== null && extracted[1] !== undefined) {
      state.extractedCounts.push(Number(extracted[1]));
      state.extractedEvidence.push(bounded(segment, "extraction evidence"));
      continue;
    }
    const verified = /^Verified ([0-9]+) files, no errors detected!$/u.exec(segment);
    if (verified !== null && verified[1] !== undefined) {
      state.verificationEvidence.push(bounded(segment, "checksum evidence"));
      state.verifiedFiles = Number(verified[1]);
      state.skippedFiles = 0;
      continue;
    }
    const skipped = /^Verified ([0-9]+) files, ([0-9]+) files skipped \(MD5 hash entry was empty\)$/u.exec(segment);
    if (skipped !== null && skipped[1] !== undefined && skipped[2] !== undefined) {
      state.verificationEvidence.push(bounded(segment, "checksum evidence"));
      state.verifiedFiles = Number(skipped[1]);
      state.skippedFiles = Number(skipped[2]);
      continue;
    }
    if (/^(?:Extracting files|Reading PCK archive)\b/u.test(segment) || /^[A-Za-z ]+\.\.\. \[/u.test(segment)) continue;
    // Runtime banners, input/version lines, and progress fragments are accepted
    // as administrative output; contradictory anchored markers remain authoritative.
  }
};

interface ArtifactExpectation {
  readonly expectedFiles: ReadonlyMap<string, string>;
  readonly expectedDirectories: ReadonlySet<string>;
}

const expectedArtifacts = (
  effectiveOutput: string,
  fullMembers: readonly string[],
  selectedMembers: readonly string[],
  observation: ProcessObservation,
): ArtifactExpectation => {
  const mappingOptions = {
    effectiveOutput,
    signal: observation.abortSignal,
    deadlineMono: observation.deadlineMono,
  };
  // Map the COMPLETE preflight set first so every source/member safety,
  // collision, and runtime-log check still applies even to excluded members.
  mapExtractionMembers({ ...mappingOptions, members: fullMembers });
  const mapping = mapExtractionMembers({ ...mappingOptions, members: selectedMembers });
  const expectedFiles = new Map<string, string>();
  for (const expected of mapping.expectedPaths) expectedFiles.set(pathIdentity(expected), expected);
  const logPath = joinPath(effectiveOutput, EXTRACTION_ROOT_LOG);
  expectedFiles.set(pathIdentity(logPath), logPath);
  const expectedDirectories = new Set<string>();
  for (const member of mapping.members) {
    const parts = member.relative.split("/");
    let prefix = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      prefix = index === 0 ? parts[0]! : `${prefix}/${parts[index]!}`;
      expectedDirectories.add(pathIdentity(joinPath(effectiveOutput, ...prefix.split("/"))));
    }
  }
  return { expectedFiles, expectedDirectories };
};

interface ArtifactVerification {
  readonly data: { readonly totalFiles: number; readonly extractedFiles: number; readonly directories: number } | null;
  readonly failure: string | null;
  readonly evidence: readonly string[];
  readonly interrupted: boolean;
}

const verifyArtifacts = (
  inventory: ArtifactInventory,
  effectiveOutput: string,
  fullMembers: readonly string[],
  selectedMembers: readonly string[],
  observation: ProcessObservation,
): ArtifactVerification => {
  const interruptedResult = (evidence: readonly string[]): ArtifactVerification => ({
    data: null,
    failure: null,
    evidence,
    interrupted: true,
  });
  if (interrupted(observation)) return interruptedResult([]);
  if (!inventory.complete) {
    return {
      data: null,
      failure: `the retained artifact inventory is incomplete: ${inventory.errors[0] ?? "one or more entries could not be verified"}`,
      evidence: inventory.errors.map((error) => `artifact inventory error: ${bounded(error)}`),
      interrupted: false,
    };
  }
  if (inventory.errors.length > 0) {
    return {
      data: null,
      failure: `the retained artifact inventory reported errors: ${inventory.errors[0]!}`,
      evidence: inventory.errors.map((error) => `artifact inventory error: ${bounded(error)}`),
      interrupted: false,
    };
  }
  const expectation = expectedArtifacts(effectiveOutput, fullMembers, selectedMembers, observation);
  const seen = new Set<string>();
  const evidence: string[] = [];
  const entries = inventory.entries as readonly ArtifactEntry[];
  for (let index = 0; index < entries.length; index += 1) {
    if (interrupted(observation)) return interruptedResult(evidence);
    const entry = entries[index]!;
    const identity = pathIdentity(entry.path);
    if (seen.has(identity)) {
      return { data: null, failure: `artifact inventory contains a duplicate path: ${entry.path}`, evidence, interrupted: false };
    }
    seen.add(identity);
    if (entry.kind === "directory") {
      if (entry.error !== null) {
        return { data: null, failure: `artifact entry could not be verified: ${bounded(entry.error)}`, evidence, interrupted: false };
      }
      if (!expectation.expectedDirectories.has(identity)) {
        return { data: null, failure: `extraction produced an unexpected directory: ${entry.path}`, evidence, interrupted: false };
      }
      continue;
    }
    if (entry.kind !== "file") {
      return { data: null, failure: `extraction produced an unsupported artifact kind (${entry.kind}): ${entry.path}`, evidence, interrupted: false };
    }
    if (entry.error !== null) {
      return { data: null, failure: `artifact entry could not be verified: ${bounded(entry.error)}`, evidence, interrupted: false };
    }
    if (!expectation.expectedFiles.has(identity)) {
      return { data: null, failure: `extraction produced an unexpected regular file: ${entry.path}`, evidence, interrupted: false };
    }
    if (entry.bytes === null || entry.sha256 === null || !HASH_PATTERN.test(entry.sha256)) {
      return { data: null, failure: `extracted file lacks complete bytes/SHA-256 evidence: ${entry.path}`, evidence, interrupted: false };
    }
  }
  for (const [identity, expected] of expectation.expectedFiles) {
    if (interrupted(observation)) return interruptedResult(evidence);
    if (!seen.has(identity)) {
      return { data: null, failure: `expected extracted file is missing from the inventory: ${expected}`, evidence, interrupted: false };
    }
  }
  for (const identity of expectation.expectedDirectories) {
    if (interrupted(observation)) return interruptedResult(evidence);
    if (!seen.has(identity)) {
      return { data: null, failure: `expected extracted directory is missing from the inventory: ${identity}`, evidence, interrupted: false };
    }
  }
  evidence.push(`Artifact inventory exactly matched ${String(selectedMembers.length)} selected member files, ${String(expectation.expectedDirectories.size)} expected directories, and the administrative ${EXTRACTION_ROOT_LOG}.`);
  evidence.push("Every extracted file carries a byte count and a SHA-256 digest in the complete inventory.");
  return {
    data: {
      totalFiles: fullMembers.length,
      extractedFiles: selectedMembers.length,
      directories: expectation.expectedDirectories.size,
    },
    failure: null,
    evidence,
    interrupted: false,
  };
};

/**
 * Artifact-dependent extraction evaluation. Complete preflight members and the
 * actual retained inventory are mandatory; exit zero alone is never success.
 */
export async function evaluateExtract(
  observation: ProcessObservation,
): Promise<EvaluationResult<ExtractSemanticData>> {
  if (interrupted(observation)) {
    return result(
      "unknown",
      "Extraction evidence evaluation was cancelled or exceeded its execution deadline.",
      ["The retained process/inventory evidence could not be fully evaluated within the operation budget."],
    );
  }
  if (observation.signal !== null) {
    return result(
      "failed",
      "GDRE extraction did not naturally finish because the process ended by signal.",
      [`Observed signal ${observation.signal}.`],
    );
  }
  if (observation.exitCode !== 0) {
    return result(
      "failed",
      "GDRE extraction did not finish with a natural exit code 0.",
      [`Observed exit code ${String(observation.exitCode)}.`],
    );
  }
  const effectiveOutput = observation.effectiveOutput;
  if (effectiveOutput === undefined || effectiveOutput.length === 0) {
    return result("unknown", "The accepted effective extraction destination was not supplied to evaluation.", ["No effective destination evidence is available."]);
  }
  // Expectations are checked under the validated canonical inventory root; the
  // caller-accepted display destination is preserved in semantic outputPath.
  const inventoryRoot = observation.effectiveOutputRealPath ?? effectiveOutput;
  const members = observation.expectedMembers;
  if (members === undefined || members.length === 0) {
    return result(
      "unknown",
      "The complete preflight member set was not available; extraction completeness cannot be claimed.",
      ["Semantic success requires a complete retained member set, not a bounded public sample or actual-output inference."],
    );
  }
  const selected = observation.expectedSelectedMembers ?? members;
  const memberSet = new Set(members);
  const outsideFullSet = selected.filter((name) => !memberSet.has(name));
  if (outsideFullSet.length > 0) {
    return result(
      "failed",
      "The selected member set is not a subset of the complete preflight member set.",
      [`Selected members absent from the complete set: ${outsideFullSet.slice(0, 8).join(", ")}.`],
    );
  }
  if (selected.length === 0) {
    return result(
      "failed",
      "The selected member set is empty; an empty selection is never a successful extraction.",
      ["A no-match selection must fail before extraction; an empty selected set cannot be reported as invented success."],
    );
  }
  const inventory = observation.artifacts;
  if (inventory === undefined) {
    return result(
      "unknown",
      "Artifact-dependent extraction evaluation was invoked without an actual inventory.",
      ["No retained output inventory was available for semantic evaluation."],
    );
  }

  const stdoutState: StdoutObservation = {
    loadedMarkers: 0,
    completionMarkers: 0,
    extractedCounts: [],
    extractedEvidence: [],
    verificationEvidence: [],
    verifiedFiles: null,
    skippedFiles: null,
    openings: [],
    error: null,
    unknown: null,
  };
  const stdoutScan = await scanRetainedTextLines(
    observation,
    observation.stdout,
    observation.stdoutEvidence,
    observation.stdoutTruncated,
    (line) => inspectStdoutLine(stdoutState, line),
  );
  const effectiveStdoutScan = stdoutScan;

  if (effectiveStdoutScan.interrupted || interrupted(observation)) {
    return result(
      "unknown",
      "Extraction evidence scanning was cancelled or exceeded its execution deadline.",
      [effectiveStdoutScan.error ?? "The complete stdout evidence could not be scanned within the operation budget."],
    );
  }
  if (!effectiveStdoutScan.complete || !effectiveStdoutScan.utf8Valid) {
    return result(
      "unknown",
      "Complete extraction stdout evidence could not be established.",
      [effectiveStdoutScan.error ?? "stdout evidence was incomplete or not valid UTF-8."],
    );
  }

  const stderr = await scanKnownStderrDiagnostics(
    observation,
    observation.stderr,
    observation.stderrEvidence,
    observation.stderrTruncated ?? false,
  );
  if (stderr.scan.interrupted || interrupted(observation)) {
    return result(
      "unknown",
      "Extraction stderr evidence scanning was cancelled or exceeded its execution deadline.",
      [stderr.scan.error ?? "The complete stderr evidence could not be scanned within the operation budget."],
    );
  }
  if (!stderr.scan.complete || !stderr.scan.utf8Valid) {
    return result(
      "unknown",
      "Complete extraction stderr evidence could not be established.",
      [stderr.scan.error ?? "stderr evidence was incomplete or not valid UTF-8."],
    );
  }
  if (stderr.diagnosticError !== null) {
    return result(
      "failed",
      "GDRE reported an extraction error on stderr.",
      [stderr.diagnosticError, ...stderr.diagnosticEvidence],
    );
  }
  if (stderr.unknown !== null) {
    return result(
      "unknown",
      "GDRE stderr contained an unclassified diagnostic; extraction success cannot be confirmed.",
      [stderr.unknown, ...stderr.diagnosticEvidence],
    );
  }
  if (stdoutState.error !== null) {
    return result(
      "failed",
      "GDRE stdout reported an extraction, load, checksum, or write error.",
      [stdoutState.error],
    );
  }
  if (stdoutState.unknown !== null) {
    return result(
      "unknown",
      "GDRE stdout contained an unclassified diagnostic; extraction success cannot be confirmed.",
      [stdoutState.unknown],
    );
  }
  if (stdoutState.loadedMarkers === 0) {
    return result(
      "failed",
      "Extraction output did not confirm that the prepared input was loaded.",
      ["The anchored `Successfully loaded PCK!` marker was not observed."],
    );
  }
  if (stdoutState.loadedMarkers > 1) {
    return result(
      "unknown",
      "Extraction output contained multiple load markers; the actual loaded graph is ambiguous.",
      [`Observed ${String(stdoutState.loadedMarkers)} anchored load markers.`],
    );
  }
  if (observation.expectedLoads === undefined) {
    return result(
      "unknown",
      "The prepared loader graph was not available; the extractor's actual input graph cannot be corroborated.",
      ["Anchored opening evidence cannot be compared without expectedLoads."],
    );
  }
  if (!openingsMatchExpectedLoads(stdoutState.openings, observation.expectedLoads, observation.redactText)) {
    return result(
      "unknown",
      "GDRE extraction opened a different set of input or dependency paths than the prepared graph.",
      ["The complete anchored opening evidence did not corroborate the prepared extraction input graph."],
    );
  }
  if (stdoutState.extractedCounts.length === 0) {
    return result(
      "unknown",
      "Extraction output did not contain an anchored extracted-file summary.",
      ["Expected exactly one `Extracted N files, no errors detected!` line."],
    );
  }
  if (stdoutState.extractedCounts.length > 1) {
    return result(
      "unknown",
      "Extraction output contained multiple extracted-file summaries; the result is ambiguous.",
      [`Observed ${String(stdoutState.extractedCounts.length)} extracted-file summary lines.`],
    );
  }
  const extractedFiles = stdoutState.extractedCounts[0]!;
  if (extractedFiles !== selected.length) {
    return result(
      "failed",
      "Extraction reported a file count that does not match the selected member set.",
      [`Selected ${String(selected.length)} files but extraction reported ${String(extractedFiles)}.`],
    );
  }
  const verificationPresent = stdoutState.verificationEvidence.length > 0;
  const checksumSkipBySource = !verificationPresent && graphSkipsPckChecks(observation.expectedLoads);
  if (!verificationPresent && !checksumSkipBySource) {
    return result(
      "unknown",
      "Default checksum verification evidence was not observed.",
      ["Expected an anchored `Verified N files...` marker because the corroborated graph loads PCK/EXE or an unrecognized file source."],
    );
  }
  if (verificationPresent && stdoutState.verificationEvidence.length > 1) {
    return result(
      "unknown",
      "Extraction output contained multiple checksum summaries; verification coverage is ambiguous.",
      [`Observed ${String(stdoutState.verificationEvidence.length)} verification summary lines.`],
    );
  }
  if (
    verificationPresent &&
    (stdoutState.verifiedFiles === null ||
      stdoutState.skippedFiles === null ||
      stdoutState.verifiedFiles + stdoutState.skippedFiles !== members.length)
  ) {
    return result(
      "failed",
      "Checksum verification coverage did not match the complete preflight member set.",
      [`Verified ${String(stdoutState.verifiedFiles)} and skipped ${String(stdoutState.skippedFiles)} files for ${String(members.length)} expected members.`],
    );
  }
  if (stdoutState.completionMarkers === 0) {
    return result(
      "unknown",
      "The anchored extraction completion marker was not observed.",
      ["Expected exactly one `Extraction operation complete in...` line."],
    );
  }
  if (stdoutState.completionMarkers > 1) {
    return result(
      "unknown",
      "Extraction output contained multiple completion markers; the result is ambiguous.",
      [`Observed ${String(stdoutState.completionMarkers)} completion markers.`],
    );
  }

  if (!inventory.complete || inventory.errors.length > 0) {
    return result(
      "unknown",
      "The retained artifact inventory is incomplete; extraction success cannot be claimed.",
      inventory.errors.length > 0
        ? inventory.errors.map((error) => `artifact inventory error: ${bounded(error)}`)
        : ["Artifact inventory completeness was not established."],
    );
  }

  let artifacts: ArtifactVerification;
  try {
    artifacts = verifyArtifacts(inventory, inventoryRoot, members, selected, observation);
  } catch (error) {
    if (interrupted(observation)) {
      return result(
        "unknown",
        "Artifact verification was cancelled or exceeded its execution deadline.",
        ["Member mapping or inventory verification did not complete within the operation budget."],
      );
    }
    return result(
      "failed",
      `The complete preflight member set could not be mapped to safe destination paths: ${error instanceof Error ? error.message : String(error)}`,
      [error instanceof ExtractionPathError ? "Member mapping was rejected as path_unsupported." : "Member mapping failed."],
    );
  }
  if (artifacts.interrupted) {
    return result(
      "unknown",
      "Artifact verification was cancelled or exceeded its execution deadline.",
      [...artifacts.evidence, "The complete inventory could not be verified within the operation budget."],
    );
  }
  if (artifacts.failure !== null || artifacts.data === null) {
    return result(
      "failed",
      `Extraction artifacts did not match the complete expected member set: ${artifacts.failure ?? "artifact verification failed"}`,
      [...artifacts.evidence],
    );
  }
  if (interrupted(observation)) {
    return result(
      "unknown",
      "Extraction evidence evaluation exceeded its execution deadline.",
      ["Artifact-dependent evaluation did not complete within the operation budget."],
    );
  }

  const checksumEvidence = verificationPresent
    ? [
        stdoutState.verificationEvidence[0]!,
        stdoutState.skippedFiles !== null && stdoutState.skippedFiles > 0
          ? `Checksum verification skipped ${String(stdoutState.skippedFiles)} file(s) whose PCK MD5 entry was empty; no universal PCK MD5 coverage is claimed.`
          : "Default checksum verification reported no checksum errors.",
      ]
    : [
        "No PCK/EXE pack metadata was loaded for the corroborated non-PCK source graph, so the runtime produced no MD5 verification summary; the default checksum policy was unchanged and no universal checksum coverage is claimed.",
      ];

  const checksumCoverage = verificationPresent
    ? { scope: "all-members" as const, verifiedFiles: stdoutState.verifiedFiles, skippedFiles: stdoutState.skippedFiles }
    : { scope: "not-applicable" as const, verifiedFiles: null, skippedFiles: null };

  return success(
    selected.length === members.length
      ? "GDRE extracted the complete expected member set with complete artifact evidence."
      : "GDRE extracted the selected member subset with complete artifact evidence.",
    [
      `Natural exit code 0 is accepted for extraction.`,
      bounded(`Prepared input loaded; ${String(members.length)} complete preflight members with ${String(selected.length)} selected.`),
      ...checksumEvidence,
      stdoutState.extractedEvidence[0]!,
      "The extraction completion marker was observed.",
      ...artifacts.evidence,
    ],
    {
      totalFiles: artifacts.data.totalFiles,
      selectedFiles: selected.length,
      extractedFiles: artifacts.data.extractedFiles,
      outputPath: effectiveOutput,
      checksum: "default",
      checksumCoverage,
    },
  );
}
