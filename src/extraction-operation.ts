import type { ArtifactInventory, ArtifactRoot } from "./artifacts.js";
import {
  EXTRACTION_ROOT_LOG,
  mapExtractionMembers,
  prepareExtractionDestination,
  revalidateExtractionDestination,
  type ExtractionDestinationPreparation,
  type ExtractionMemberMapping,
} from "./extraction-paths.js";
import { EXTRACT_RULE } from "./extraction.js";
import {
  deriveSelectedMembers,
  type ExtractionSelectionMode,
  type ExtractionSourceKind,
} from "./extraction-selection.js";
import {
  collectCompleteListingMembers,
  LIST_FILES_RULE,
  type CompleteListingEvidence,
} from "./listing.js";
import {
  type ListingDirectoryInspector,
  type ListingPreparation,
} from "./listing-paths.js";
import { joinPath, pathIdentity } from "./paths.js";
import { admittedPrimaryInputs } from "./output-placement.js";
import { listFilesCommand } from "./registry.js";
import {
  hashEvidenceFile,
  StorageError,
  type OperationStorage,
} from "./storage.js";
import { boundedUtf8 } from "./text.js";
import type {
  ErrorCode,
  ExtractInput,
  InvocationPlan,
  ListFilesInput,
  ListFilesSessionAction,
  OperationResult,
  Phase,
  ProcessObservation,
} from "./types.js";

/**
 * Per-call extraction preparation and evidence interpretation. It owns the
 * destination snapshot, complete/selected member state, preflight evidence and
 * extraction-specific observation/inventory interpretation. It does not own
 * process launches, native ownership, timeouts, progress or publication.
 */

const MAX_EVIDENCE = 32;

export const EXTRACTION_EVIDENCE_NAMESPACE = "preflight";

const bounded = (value: unknown, fallback: string): string =>
  boundedUtf8(value, fallback);

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : String(error ?? fallback);

export interface PreflightRunEvidence {
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly spawnError: { readonly code: string; readonly message: string } | null;
  readonly spawnedAt: string | null;
  readonly exitedAt: string | null;
  readonly spawnedAtMono: number | null;
  readonly exitedAtMono: number | null;
  readonly cleanup: {
    readonly state: "not_needed" | "confirmed" | "unconfirmed";
    readonly trigger: OperationResult["cleanup"]["trigger"];
    readonly actions: readonly string[];
    readonly error: string | null;
  };
  readonly stdout: OperationResult["stdout"];
  readonly stderr: OperationResult["stderr"];
}

export interface ExtractionPreparationInput {
  readonly run: PreflightRunEvidence;
  /** Base process observation; listing corpora are parsed from the retained streams. */
  readonly observation: ProcessObservation;
  /** The launched preflight was stopped or failed, so its output is not evaluated. */
  readonly processStopped: boolean;
  readonly executable: string;
  readonly plan: InvocationPlan;
  readonly environmentProfile: Record<string, unknown> | null;
  readonly statusPath: string;
  /** Narrow evidence capability; hashing and cancellation remain command-local. */
  readonly store: Pick<OperationStorage, "writeAuxiliaryJson">;
}

export type ExtractionPreparationResult =
  | { readonly ready: true }
  | { readonly ready: false; readonly stopped: true }
  | {
      readonly ready: false;
      readonly stopped: false;
      readonly interrupted: {
        readonly stage: Phase;
        readonly message?: string;
        readonly beforeLaunch?: true;
      };
    }
  | {
      readonly ready: false;
      readonly stopped: false;
      readonly code: ErrorCode;
      readonly summary: string;
      readonly semantic?: OperationResult["semantic"];
    };

interface SelectionRequest {
  readonly mode: ExtractionSelectionMode;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

type ExtractionSelection =
  | {
      readonly ok: true;
      readonly classification: "selected" | "no_match";
      readonly members: readonly string[];
      readonly request: SelectionRequest;
      readonly provenance: SelectionRequest;
      readonly sourceKind: ExtractionSourceKind;
    }
  | {
      readonly ok: false;
      readonly reason: "directory_filter_unsupported";
      readonly message: string;
      readonly patterns: readonly string[];
      readonly request: SelectionRequest;
      readonly provenance: SelectionRequest;
      readonly sourceKind: ExtractionSourceKind;
    };

export interface ExtractionOperationOptions {
  readonly workspace: string;
  readonly operationDirectory: string;
  readonly input: ExtractInput;
  readonly session: readonly ListFilesSessionAction[];
  readonly preparedInputs: ListingPreparation;
  readonly signal: AbortSignal;
  readonly directoryInspector?: ListingDirectoryInspector;
}

export const extractionEvidencePaths = (
  operationDirectory: string,
): readonly string[] => [
  joinPath(operationDirectory, EXTRACTION_EVIDENCE_NAMESPACE, "stdout.bin"),
  joinPath(operationDirectory, EXTRACTION_EVIDENCE_NAMESPACE, "stdout.txt"),
  joinPath(operationDirectory, EXTRACTION_EVIDENCE_NAMESPACE, "stderr.bin"),
  joinPath(operationDirectory, EXTRACTION_EVIDENCE_NAMESPACE, "stderr.txt"),
  joinPath(operationDirectory, EXTRACTION_EVIDENCE_NAMESPACE, "expected-members.json"),
  joinPath(operationDirectory, EXTRACTION_EVIDENCE_NAMESPACE, "selected-members.json"),
];

export class ExtractionOperation {
  private readonly workspace: string;
  private readonly operationDirectory: string;
  private readonly input: ExtractInput;
  private readonly session: readonly ListFilesSessionAction[];
  private readonly signal: AbortSignal;
  private readonly directoryInspector: ListingDirectoryInspector | undefined;
  private preparedInputs: ListingPreparation;
  private destination: ExtractionDestinationPreparation | undefined;
  private mapping: ExtractionMemberMapping | undefined;
  private selectedMembers: readonly string[] | undefined;
  private listingEvidence: CompleteListingEvidence | null = null;
  private preflightRecord: Record<string, unknown> | null = null;
  private expectedMembersSha256: string | null = null;
  private attempted = false;

  public constructor(options: ExtractionOperationOptions) {
    this.workspace = options.workspace;
    this.operationDirectory = options.operationDirectory;
    this.input = options.input;
    this.session = [...options.session];
    this.preparedInputs = options.preparedInputs;
    this.signal = options.signal;
    this.directoryInspector = options.directoryInspector;
  }

  public get effectiveOutput(): string | undefined {
    return this.destination?.effectiveOutput;
  }

  public get preflightEvidence(): Record<string, unknown> | null {
    return this.preflightRecord;
  }

  public get preflightStatusPath(): string {
    return joinPath(this.operationDirectory, EXTRACTION_EVIDENCE_NAMESPACE, "ownership.json");
  }

  public async prepareDestination(): Promise<void> {
    this.destination = await prepareExtractionDestination({
      workspace: this.workspace,
      operationDirectory: this.operationDirectory,
      requestedOutput: this.input.output,
      defaultPlacement: {
        kind: "extracted",
        primaryInputs: admittedPrimaryInputs(this.preparedInputs),
      },
      preparedInputs: this.preparedInputs,
      signal: this.signal,
      directoryInspector: this.directoryInspector,
    });
  }

  /** Re-resolve the destination and adopt the revalidated listing graph. */
  public async revalidateDestination(
    preparedInputs: ListingPreparation,
  ): Promise<void> {
    this.preparedInputs = preparedInputs;
    if (this.destination === undefined) return;
    this.destination = await revalidateExtractionDestination(this.destination, {
      signal: this.signal,
      directoryInspector: this.directoryInspector,
    });
  }

  /**
   * Build the listing argv through the registered listing planner. Only
   * listing-admitted fields are supplied: prepared input groups and the
   * effective session. Extraction filters, mode and destination never enter
   * the preflight plan, and no second timeout is introduced.
   */
  public preflightPlan(): InvocationPlan {
    const listingInput: ListFilesInput = {
      inputs: [...this.preparedInputs.inputEntries],
      session: [...this.session],
    };
    return listFilesCommand.plan(listingInput, {
      workspace: this.workspace,
      operationDirectory: this.operationDirectory,
      resolvedInputs: this.preparedInputs.resolvedInputs,
    });
  }

  /**
   * Consume one completed preflight attempt and produce everything the main
   * extraction launch needs: retained preflight evidence, complete-member
   * mapping, derived selection and selected-member evidence. The caller keeps
   * the acquired process/cleanup observation and terminal classification.
   */
  public async prepareFromPreflight(
    input: ExtractionPreparationInput,
  ): Promise<ExtractionPreparationResult> {
    if (input.processStopped) {
      this.recordPreflightEvidence(
        input,
        this.skippedListingEvidence(input.run),
      );
      return { ready: false, stopped: true };
    }

    const evidence = await collectCompleteListingMembers(input.observation);
    this.recordPreflightEvidence(input, evidence);
    if (this.signal.aborted) {
      return { ready: false, stopped: false, interrupted: { stage: "running" } };
    }
    if (evidence.status !== "succeeded") {
      return this.preflightRejection(evidence);
    }

    const expectedFailure = await this.persistExpectedMembers(input);
    if (expectedFailure !== null) return expectedFailure;

    const mappingFailure = this.mapCompleteMembers();
    if (mappingFailure !== null) return mappingFailure;

    const selection = this.deriveSelection();
    if (!this.isSelection(selection)) return selection;

    const selectedFailure = await this.persistSelectedMembers(input, selection);
    if (selectedFailure !== null) return selectedFailure;

    return this.selectionRejection(selection) ?? { ready: true };
  }

  public markAttempted(): void {
    this.attempted = true;
  }

  /** Attach extraction expectations to a generic process observation. */
  public enrichObservation(base: ProcessObservation): ProcessObservation {
    const mappedMembers = this.mapping?.members.map((member) => member.member);
    return {
      ...base,
      expectedMembers: mappedMembers,
      expectedSelectedMembers: this.selectedMembers ?? mappedMembers,
      effectiveOutput: this.destination?.effectiveOutput,
      effectiveOutputRealPath: this.destination?.effectiveRealPath,
    };
  }

  public evaluationObservation(
    base: ProcessObservation,
    artifacts: ArtifactInventory,
  ): ProcessObservation {
    return { ...this.enrichObservation(base), artifacts };
  }

  /**
   * Inventory only the accepted destination when it is operation-owned or
   * exactly revalidated; never adopt unrelated files from a planned root.
   */
  public inventoryRoots(operationOutput: string): readonly ArtifactRoot[] {
    const destination = this.destination;
    if (destination === undefined) {
      return [{ path: operationOutput, role: "output" }];
    }
    if (destination.effectiveIdentity === destination.ownedIdentity) {
      return [{ path: destination.effectiveRealPath, role: "output" }];
    }
    const roots: ArtifactRoot[] = [{ path: operationOutput, role: "output" }];
    if (this.attempted) {
      roots.push({ path: destination.effectiveRealPath, role: "extraction-destination" });
    }
    return roots;
  }

  /** Separate the administrative runtime log from extracted member artifacts. */
  public interpretInventory(inventory: ArtifactInventory): ArtifactInventory {
    const destination = this.destination;
    if (destination === undefined) return inventory;
    const logIdentity = pathIdentity(
      joinPath(destination.effectiveRealPath, EXTRACTION_ROOT_LOG),
    );
    return {
      ...inventory,
      entries: inventory.entries.map((entry) => {
        const identity = pathIdentity(entry.path);
        if (identity === logIdentity) {
          return { ...entry, role: "administrative-log" };
        }
        if (
          identity === destination.effectiveIdentity ||
          identity.startsWith(`${destination.effectiveIdentity}/`)
        ) {
          return { ...entry, role: "extracted" };
        }
        return entry;
      }),
    };
  }

  private skippedListingEvidence(
    run: PreflightRunEvidence,
  ): CompleteListingEvidence {
    return {
      status: "unknown",
      rule: LIST_FILES_RULE,
      summary: "Preflight evidence was not evaluated after the process failed or stopped.",
      evidence: [],
      members: [],
      totalFiles: null,
      stdoutPath: run.stdout.textPath ?? "",
    };
  }

  private recordPreflightEvidence(
    input: ExtractionPreparationInput,
    evidence: CompleteListingEvidence,
  ): void {
    this.listingEvidence = evidence;
    this.preflightRecord = {
      invocation: {
        executable: input.executable,
        argv: [...input.plan.argv],
        cwd: input.plan.cwd,
        environmentProfile: input.environmentProfile,
      },
      process: {
        pid: input.run.pid,
        exitCode: input.run.exitCode,
        signal: input.run.signal,
        spawnError: input.run.spawnError,
      },
      cleanup: {
        state: input.run.cleanup.state,
        trigger: input.run.cleanup.trigger,
        actions: [...input.run.cleanup.actions],
        error: input.run.cleanup.error,
      },
      timing: {
        spawnedAt: input.run.spawnedAt,
        exitedAt: input.run.exitedAt,
        processMs:
          input.run.spawnedAtMono !== null && input.run.exitedAtMono !== null
            ? Math.max(0, Math.round(input.run.exitedAtMono - input.run.spawnedAtMono))
            : null,
      },
      ownership: {
        statusPath: input.statusPath,
        state: input.run.cleanup.state,
        trigger: input.run.cleanup.trigger,
        actions: [...input.run.cleanup.actions],
        error: input.run.cleanup.error,
      },
      stdout: {
        rawPath: input.run.stdout.rawPath,
        textPath: input.run.stdout.textPath,
        bytes: input.run.stdout.bytes,
        complete: input.run.stdout.complete,
        utf8Valid: input.run.stdout.utf8Valid,
        truncated: input.run.stdout.truncated,
      },
      stderr: {
        rawPath: input.run.stderr.rawPath,
        textPath: input.run.stderr.textPath,
        bytes: input.run.stderr.bytes,
        complete: input.run.stderr.complete,
        utf8Valid: input.run.stderr.utf8Valid,
        truncated: input.run.stderr.truncated,
      },
      semantic: {
        status: input.processStopped ? "not_evaluated" : evidence.status,
        rule: evidence.rule,
        summary: evidence.summary,
        evidence: [...evidence.evidence],
        data: null,
      },
      expectedMembers: null,
    };
  }

  private preflightRejection(
    evidence: CompleteListingEvidence,
  ): ExtractionPreparationResult {
    const summary = `Extraction preflight did not establish a complete expected member set: ${evidence.summary}`;
    return {
      ready: false,
      stopped: false,
      code: evidence.status === "unknown" ? "semantic_unknown" : "semantic_failed",
      summary,
      semantic: {
        status: evidence.status,
        rule: EXTRACT_RULE,
        summary: bounded(summary, "extraction preflight failed"),
        evidence: evidence.evidence
          .slice(0, MAX_EVIDENCE)
          .map((line) => bounded(line, "preflight evidence")),
        data: null,
      },
    };
  }

  private async persistExpectedMembers(
    input: ExtractionPreparationInput,
  ): Promise<ExtractionPreparationResult | null> {
    const members = this.listingEvidence?.members ?? [];
    const evidencePath = await this.writeEvidence(input.store, {
      name: "expected-members.json",
      record: {
        schemaVersion: 1,
        complete: true,
        source: "internal --list-files preflight",
        count: members.length,
        members: [...members],
      },
    }, "expected-member evidence could not be persisted", true);
    if (this.signal.aborted) {
      return { ready: false, stopped: false, interrupted: { stage: "running", beforeLaunch: true } };
    }
    const evidenceHash = await hashEvidenceFile(evidencePath, this.signal);
    if (this.signal.aborted) {
      return { ready: false, stopped: false, interrupted: { stage: "running", beforeLaunch: true } };
    }
    if (evidenceHash.sha256 === null) {
      throw new StorageError(
        `expected-member evidence could not be hashed: ${evidenceHash.error ?? "unknown error"}`,
      );
    }
    if (this.preflightRecord === null) {
      throw new StorageError("preflight evidence record was not initialized");
    }
    this.preflightRecord.expectedMembers = {
      path: evidencePath,
      count: members.length,
      sha256: evidenceHash.sha256,
      bytes: evidenceHash.bytes,
    };
    this.expectedMembersSha256 = evidenceHash.sha256;
    return null;
  }

  private mapCompleteMembers(): ExtractionPreparationResult | null {
    const members = this.listingEvidence?.members;
    const effectiveOutput = this.destination?.effectiveOutput;
    if (members === undefined || effectiveOutput === undefined) {
      throw new Error(
        "complete preflight members and effective extraction output are required before mapping",
      );
    }
    try {
      this.mapping = mapExtractionMembers({
        effectiveOutput,
        members,
        signal: this.signal,
      });
      return null;
    } catch (error) {
      if (this.signal.aborted) {
        return {
          ready: false,
          stopped: false,
          interrupted: {
            stage: "finalizing",
            message: "The operation was cancelled while validating the complete member set.",
          },
        };
      }
      const detail = bounded(
        messageOf(error, "complete preflight member mapping was rejected"),
        "complete preflight member mapping was rejected",
      );
      return {
        ready: false,
        stopped: false,
        code: "path_unsupported",
        summary: detail,
        semantic: {
          status: "failed",
          rule: EXTRACT_RULE,
          summary: "The complete preflight member set could not be mapped to safe destination paths.",
          evidence: [detail],
          data: null,
        },
      };
    }
  }

  private deriveSelection(): ExtractionSelection | ExtractionPreparationResult {
    const completeMembers = this.listingEvidence?.members;
    if (completeMembers === undefined) {
      throw new Error("complete preflight members are required before selection");
    }
    const sourceKind = this.sourceKind();
    const request: SelectionRequest = {
      mode: this.input.selection ?? "all",
      include: [...(this.input.include ?? [])],
      exclude: [...(this.input.exclude ?? [])],
    };
    const provenance: SelectionRequest = {
      mode: request.mode,
      include: [...request.include],
      exclude: [...request.exclude],
    };
    let derived: ReturnType<typeof deriveSelectedMembers>;
    try {
      derived = deriveSelectedMembers(
        request,
        completeMembers,
        sourceKind,
        { signal: this.signal },
      );
    } catch (error) {
      if (this.signal.aborted) {
        return {
          ready: false,
          stopped: false,
          interrupted: {
            stage: "finalizing",
            message: "The operation was cancelled while deriving the selected member set.",
          },
        };
      }
      return {
        ready: false,
        stopped: false,
        code: "semantic_failed",
        summary: bounded(
          messageOf(error, "selected member derivation failed"),
          "selected member derivation failed",
        ),
      };
    }
    if (!derived.ok) {
      return {
        ok: false,
        reason: derived.reason,
        message: derived.message,
        patterns: derived.patterns,
        request,
        provenance,
        sourceKind,
      };
    }
    if (derived.classification === "selected") {
      this.selectedMembers = derived.expectedMembers;
    }
    return {
      ok: true,
      classification: derived.classification,
      members: derived.expectedMembers,
      request,
      provenance,
      sourceKind,
    };
  }

  private async persistSelectedMembers(
    input: ExtractionPreparationInput,
    selection: ExtractionSelection,
  ): Promise<ExtractionPreparationResult | null> {
    const full = {
      count: this.listingEvidence?.members.length ?? 0,
      expectedMembersSha256: this.expectedMembersSha256,
    };
    const evidence = !selection.ok
      ? {
          schemaVersion: 1,
          complete: false,
          source: "selection unsupported",
          reason: selection.reason,
          request: selection.provenance,
          sourceKind: selection.sourceKind,
          rejectedPatterns: [...selection.patterns],
          full,
        }
      : {
          schemaVersion: 1,
          complete: true,
          source: "derived from accepted selection semantics",
          count: selection.members.length,
          members: [...selection.members],
          request: selection.provenance,
          sourceKind: selection.sourceKind,
          full,
        };
    const recordPath = await this.writeEvidence(
      input.store,
      { name: "selected-members.json", record: evidence },
      "selected-member evidence could not be persisted",
      false,
    );
    if (this.signal.aborted) {
      return { ready: false, stopped: false, interrupted: { stage: "running", beforeLaunch: true } };
    }
    const hash = await hashEvidenceFile(recordPath, this.signal);
    if (this.signal.aborted) {
      return { ready: false, stopped: false, interrupted: { stage: "running", beforeLaunch: true } };
    }
    if (hash.sha256 === null) {
      throw new StorageError(
        `selected-member evidence could not be hashed: ${hash.error ?? "unknown error"}`,
      );
    }
    if (this.preflightRecord === null) {
      throw new StorageError("preflight evidence record was not initialized");
    }
    this.preflightRecord.selectedMembers = {
      path: recordPath,
      count: typeof evidence.count === "number" ? evidence.count : null,
      complete: evidence.complete,
      sha256: hash.sha256,
      bytes: hash.bytes,
    };
    return null;
  }

  private selectionRejection(
    selection: ExtractionSelection,
  ): ExtractionPreparationResult | null {
    if (!selection.ok) {
      const summary = `The selection cannot be fulfilled for this ${selection.sourceKind} source: ${selection.message}.`;
      return {
        ready: false,
        stopped: false,
        code: "unsupported_capability",
        summary,
        semantic: {
          status: "failed",
          rule: EXTRACT_RULE,
          summary: bounded(summary, "selection failed"),
          evidence: [
            `Rejected directory filter patterns: ${selection.patterns.join(", ")}.`,
          ],
          data: null,
        },
      };
    }
    if (selection.classification === "no_match") {
      const summary =
        "The selection matched no package member; no extraction was launched and the runtime's extract-everything fallback was not used.";
      return {
        ready: false,
        stopped: false,
        code: "semantic_failed",
        summary,
        semantic: {
          status: "failed",
          rule: EXTRACT_RULE,
          summary: bounded(summary, "selection failed"),
          evidence: [
            `Selection mode ${selection.request.mode} with ${String(selection.request.include.length)} include and ${String(selection.request.exclude.length)} exclude patterns matched no member.`,
          ],
          data: null,
        },
      };
    }
    return null;
  }

  private async writeEvidence(
    store: Pick<OperationStorage, "writeAuxiliaryJson">,
    evidence: { readonly name: string; readonly record: Record<string, unknown> },
    failureMessage: string,
    rethrowIfInactive: boolean,
  ): Promise<string> {
    try {
      return await store.writeAuxiliaryJson(
        EXTRACTION_EVIDENCE_NAMESPACE,
        evidence.name,
        evidence.record,
      );
    } catch (error) {
      if (rethrowIfInactive && this.signal.aborted) throw error;
      throw error instanceof StorageError
        ? error
        : new StorageError(
            `${failureMessage}: ${bounded(error, "storage failure")}`,
            { cause: error },
          );
    }
  }

  private isSelection(
    value: ExtractionSelection | ExtractionPreparationResult,
  ): value is ExtractionSelection {
    return "ok" in value;
  }

  private sourceKind(): ExtractionSourceKind {
    const primaryFingerprint = this.preparedInputs.fingerprints.find(
      (fingerprint) => fingerprint.role === "input",
    );
    return primaryFingerprint !== undefined &&
      primaryFingerprint.kind === "directory" &&
      !/\.app$/iu.test(primaryFingerprint.path)
      ? "directory"
      : "package";
  }
}
