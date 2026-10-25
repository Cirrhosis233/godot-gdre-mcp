import type { ArtifactInventory, ArtifactRoot } from "./artifacts.js";
import type { ExtractionDestinationPreparation } from "./extraction-paths.js";
import type {
  ExtractionPreparationResult,
  PreflightRunEvidence,
} from "./extraction-operation.js";
import { evaluateExport } from "./export-evaluation.js";
import {
  buildExportExpectations,
  buildExportPreflightPlan,
  combineInputFingerprints,
  EXPORT_EVIDENCE_NAMESPACE,
  EXPORT_RULE,
  exportAdministrativePaths,
  exportPreflightEvidencePath,
  isExportAccompanyingRelative,
  normalizeExportOutputPath,
  prepareExportDestination,
  prepareExportHints,
  revalidateExportDestination,
  revalidateExportHints,
  selectExportMembers,
  sourceKindFromPreparation,
  ExportPathError,
  type ExportExpectations,
  type ExportSelectionOutcome,
} from "./export-planning.js";
import {
  ExportPreflightError,
  readExportPreflightEvidence,
  type ExportPreflightEvidence,
} from "./export-preflight.js";
import type {
  ListingDirectoryInspector,
  ListingPreparation,
} from "./listing-paths.js";
import { joinPath, pathIdentity } from "./paths.js";
import { admittedPrimaryInputs } from "./output-placement.js";
import {
  hashEvidenceFile,
  StorageError,
  type OperationStorage,
} from "./storage.js";
import { boundedUtf8 } from "./text.js";
import type {
  ErrorCode,
  EvaluationResult,
  ExportEvaluationContext,
  ExportResourcesInput,
  ExportSemanticData,
  InvocationPlan,
  Phase,
  ProcessObservation,
} from "./types.js";

/**
 * Per-call export preparation and evidence interpretation. It owns the
 * destination snapshot, protected hints, complete/selected member state,
 * native preflight evidence, import expectations and export-specific
 * observation/inventory interpretation. Process launches, native ownership,
 * timeouts, cancellation and publication stay in shared execution.
 */

const MAX_EVIDENCE = 32;
export const EXPORT_DETAIL_NAMESPACE = "export-detail";
export const EXPORT_EXPECTATIONS_FILENAME = "export-expectations.json";

/** Files this operation may write or read inside its own evidence namespace. */
export const exportAuxiliaryEvidencePaths = (
  operationDirectory: string,
): readonly string[] => [
  ...["stdout.bin", "stdout.txt", "stderr.bin", "stderr.txt"].map((file) =>
    joinPath(operationDirectory, EXPORT_EVIDENCE_NAMESPACE, file),
  ),
  exportPreflightEvidencePath(operationDirectory),
  joinPath(
    operationDirectory,
    EXPORT_EVIDENCE_NAMESPACE,
    EXPORT_EXPECTATIONS_FILENAME,
  ),
  joinPath(operationDirectory, EXPORT_DETAIL_NAMESPACE, "report.json"),
];

const bounded = (value: unknown, fallback: string): string =>
  boundedUtf8(value, fallback);

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : String(error ?? fallback);

export interface ExportPreparationInput {
  readonly run: PreflightRunEvidence;
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

export type ExportPreparationResult = ExtractionPreparationResult;

export interface ExportOperationOptions {
  readonly workspace: string;
  readonly operationDirectory: string;
  readonly input: ExportResourcesInput;
  readonly preparedInputs: ListingPreparation;
  readonly signal: AbortSignal;
  /** Adapter-owned fixed inspector script; never caller-controlled. */
  readonly preflightScriptPath: string;
  readonly directoryInspector?: ListingDirectoryInspector;
  readonly store?: Pick<OperationStorage, "writeAuxiliaryJson">;
}

interface ExpectationEvidence {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly completeMembers: number;
  readonly selectedMembers: number;
  readonly nativeImports: number;
  readonly unmappedMembers: number;
}

interface NativeEvidence {
  readonly path: string;
  readonly sha256: string | null;
  readonly bytes: number | null;
  readonly fileCount: number | null;
  readonly importCount: number | null;
  readonly error?: string;
}

export class ExportOperation {
  private readonly workspace: string;
  private readonly operationDirectory: string;
  private readonly input: ExportResourcesInput;
  private readonly signal: AbortSignal;
  private readonly preflightScriptPath: string;
  private readonly directoryInspector: ListingDirectoryInspector | undefined;
  private preparedInputs: ListingPreparation;
  private hints: ListingPreparation | undefined;
  private destination: ExtractionDestinationPreparation | undefined;
  private expectations: ExportExpectations | undefined;
  private selectedMembersValue: readonly string[] | undefined;
  private expectationsEvidencePath: string | null = null;
  private preflightRecord: Record<string, unknown> | null = null;
  private attempted = false;
  private store: Pick<OperationStorage, "writeAuxiliaryJson"> | undefined;

  public constructor(options: ExportOperationOptions) {
    this.workspace = options.workspace;
    this.operationDirectory = options.operationDirectory;
    this.input = options.input;
    this.preparedInputs = options.preparedInputs;
    this.signal = options.signal;
    this.preflightScriptPath = options.preflightScriptPath;
    this.directoryInspector = options.directoryInspector;
    this.store = options.store;
  }

  public get effectiveOutput(): string | undefined {
    return this.destination?.effectiveOutput;
  }

  public get preflightEvidence(): Record<string, unknown> | null {
    return this.preflightRecord;
  }

  public get preflightStatusPath(): string {
    return joinPath(this.operationDirectory, EXPORT_EVIDENCE_NAMESPACE, "ownership.json");
  }

  public get selectedMembers(): readonly string[] | undefined {
    return this.selectedMembersValue;
  }

  /** Ordered absolute translation-hint paths resolved for planning. */
  public get resolvedHints(): readonly string[] {
    return this.hints?.resolvedInputs ?? [];
  }

  /** Prepared hint fingerprints for manifest identity evidence. */
  public get hintPreparation(): ListingPreparation | undefined {
    return this.hints;
  }

  /**
   * Resolve protected translation hints first, then the exact export
   * destination with combined primary/hint fingerprints for overlap protection.
   */
  public async prepareDestination(): Promise<void> {
    this.hints = await prepareExportHints(
      this.workspace,
      this.input.translationHints,
      this.signal,
      undefined,
      { directoryInspector: this.directoryInspector },
    );
    this.destination = await prepareExportDestination({
      workspace: this.workspace,
      operationDirectory: this.operationDirectory,
      requestedOutput: this.input.output,
      defaultPlacement: {
        kind: "exported",
        primaryInputs: admittedPrimaryInputs(this.preparedInputs),
      },
      preparedInputs: combineInputFingerprints(this.preparedInputs, this.hints),
      signal: this.signal,
      directoryInspector: this.directoryInspector,
    });
  }

  /** Re-resolve hints and the destination immediately before an owned launch. */
  public async revalidateDestination(
    preparedInputs: ListingPreparation,
  ): Promise<void> {
    this.preparedInputs = preparedInputs;
    if (this.hints !== undefined) {
      this.hints = await revalidateExportHints(
        this.hints,
        this.signal,
        undefined,
        { directoryInspector: this.directoryInspector },
      );
    }
    if (this.destination === undefined) return;
    this.destination = await revalidateExportDestination(this.destination, {
      signal: this.signal,
      directoryInspector: this.directoryInspector,
    });
  }

  /**
   * Launch the fixed inspector only. Export filters, hints, destination and
   * session controls never enter the metadata preflight.
   */
  public preflightPlan(): InvocationPlan {
    return buildExportPreflightPlan({
      preflightScriptPath: this.preflightScriptPath,
      operationDirectory: this.operationDirectory,
      resolvedInputs: this.preparedInputs.resolvedInputs,
      timeoutMs: this.input.timeoutMs,
    });
  }

  /**
   * Consume one completed native preflight attempt and retain validated
   * complete/selected expectations. No-match, unsupported directory filters,
   * unsafe metadata and malformed evidence are terminal rejections, never a
   * fall-through to full recovery.
   */
  public async prepareFromPreflight(
    input: ExportPreparationInput,
  ): Promise<ExportPreparationResult> {
    this.store ??= input.store;
    if (input.processStopped) {
      this.recordPreflightEvidence(input, {
        semanticStatus: "not_evaluated",
        semanticSummary:
          "Preflight evidence was not evaluated after the process failed or stopped.",
        semanticEvidence: [],
      });
      return { ready: false, stopped: true };
    }
    if (
      input.run.exitCode !== 0 ||
      input.run.signal !== null ||
      input.run.spawnError !== null
    ) {
      const reason = `The native export preflight did not finish successfully (exit ${String(input.run.exitCode)}, signal ${String(input.run.signal)}, spawn ${input.run.spawnError === null ? "none" : input.run.spawnError.message}); no recovery was launched.`;
      this.recordPreflightEvidence(input, {
        semanticStatus: "failed",
        semanticSummary: reason,
        semanticEvidence: [reason],
      });
      return this.rejection("process_failed", reason, [reason], "failed");
    }

    const evidencePath = exportPreflightEvidencePath(this.operationDirectory);
    let evidence: ExportPreflightEvidence;
    try {
      evidence = await readExportPreflightEvidence(evidencePath, this.signal);
    } catch (error) {
      if (this.signal.aborted) return this.interrupted("running");
      if (error instanceof ExportPreflightError) {
        this.recordPreflightEvidence(input, {
          semanticStatus: error.code === "semantic_failed" ? "failed" : "unknown",
          semanticSummary: error.message,
          semanticEvidence: [error.message],
          native: {
            path: evidencePath,
            sha256: null,
            bytes: null,
            fileCount: null,
            importCount: null,
            error: error.message,
          },
        });
        return this.rejection(
          error.code,
          error.message,
          [error.message],
          error.code === "semantic_failed" ? "failed" : "unknown",
        );
      }
      throw error;
    }
    if (this.signal.aborted) return this.interrupted("running");

    const nativeHash = await hashEvidenceFile(evidencePath, this.signal);
    if (this.signal.aborted) return this.interrupted("running", undefined, true);
    if (nativeHash.sha256 === null) {
      throw new StorageError(
        `native export preflight evidence could not be hashed: ${nativeHash.error ?? "unknown error"}`,
      );
    }
    const nativeEvidence: NativeEvidence = {
      path: evidencePath,
      sha256: nativeHash.sha256,
      bytes: nativeHash.bytes,
      fileCount: evidence.files.length,
      importCount: evidence.imports.length,
    };

    const sourceKind = sourceKindFromPreparation(this.preparedInputs);
    let selection: ExportSelectionOutcome;
    try {
      selection = selectExportMembers(
        this.input.selection,
        evidence.files,
        sourceKind,
        { signal: this.signal },
      );
    } catch (error) {
      if (this.signal.aborted) return this.interrupted("finalizing");
      const detail = bounded(
        messageOf(error, "selected member derivation failed"),
        "selected member derivation failed",
      );
      this.recordPreflightEvidence(input, {
        semanticStatus: "failed",
        semanticSummary: detail,
        semanticEvidence: [detail],
        native: nativeEvidence,
      });
      return this.rejection("semantic_failed", detail, [detail], "failed");
    }
    if (this.signal.aborted) return this.interrupted("finalizing");

    if (!selection.ok) {
      const summary = `The selection cannot be fulfilled for this ${selection.sourceKind} source: ${selection.message}.`;
      this.recordPreflightEvidence(input, {
        semanticStatus: "failed",
        semanticSummary: summary,
        semanticEvidence: [
          `Rejected directory filter patterns: ${selection.patterns.join(", ")}.`,
        ],
        native: nativeEvidence,
        selection,
      });
      return this.rejection(
        "unsupported_capability",
        summary,
        [`Rejected directory filter patterns: ${selection.patterns.join(", ")}.`],
        "failed",
      );
    }
    if (selection.classification === "no_match") {
      const summary = `The selection matched no ${selection.sourceKind} member; no export was launched and the runtime's export-everything fallback was not used.`;
      this.recordPreflightEvidence(input, {
        semanticStatus: "failed",
        semanticSummary: summary,
        semanticEvidence: [
          `Selection kind ${selection.provenance.kind} matched no member.`,
        ],
        native: nativeEvidence,
        selection,
      });
      return this.rejection(
        "semantic_failed",
        summary,
        [`Selection kind ${selection.provenance.kind} matched no member.`],
        "failed",
      );
    }

    let expectations: ExportExpectations;
    try {
      expectations = buildExportExpectations({
        effectiveOutput: this.destination?.effectiveOutput ?? "",
        completeMembers: evidence.files,
        selectedMembers: selection.members,
        imports: evidence.imports,
        dumpResourceStrings: this.input.dumpResourceStrings === true,
        signal: this.signal,
      });
    } catch (error) {
      if (this.signal.aborted) return this.interrupted("finalizing");
      if (!(error instanceof ExportPathError)) throw error;
      const detail = bounded(
        messageOf(error, "retained export expectations were rejected"),
        "retained export expectations were rejected",
      );
      const summary = `The retained export member/import expectations were rejected: ${detail}`;
      this.recordPreflightEvidence(input, {
        semanticStatus: "failed",
        semanticSummary: summary,
        semanticEvidence: [detail],
        native: nativeEvidence,
        selection,
      });
      return this.rejection("path_unsupported", summary, [detail], "failed");
    }
    if (this.signal.aborted) return this.interrupted("finalizing");

    const expectationRecord = {
      schemaVersion: 1,
      complete: true,
      source: "validated adapter-owned native preflight metadata",
      selection: {
        kind: this.input.selection.kind,
        group:
          this.input.selection.kind === "group"
            ? this.input.selection.group
            : null,
        sourceKind,
        include: [...selection.provenance.include],
        exclude: [...selection.provenance.exclude],
      },
      completeMembers: [...expectations.completeMembers],
      selectedMembers: [...expectations.selectedMembers],
      imports: expectations.imports.map((entry) => ({
        index: entry.index,
        path: entry.path,
        importMdPath: entry.importMdPath,
        sourceFile: entry.sourceFile,
        importer: entry.importer,
        type: entry.type,
        destFiles: [...entry.destFiles],
        reportable: entry.reportable,
        selectedMembers: [...entry.selectedMembers],
      })),
      selectedReportableImports: expectations.selectedReportableImports.map(
        (entry) => entry.index,
      ),
      unmappedMembers: [...expectations.unmappedMembers],
      administrative: { ...expectations.administrative },
    };

    let expectationsPath: string;
    try {
      expectationsPath = await input.store.writeAuxiliaryJson(
        EXPORT_EVIDENCE_NAMESPACE,
        EXPORT_EXPECTATIONS_FILENAME,
        expectationRecord,
      );
    } catch (error) {
      if (this.signal.aborted) return this.interrupted("running", undefined, true);
      throw error instanceof StorageError
        ? error
        : new StorageError(
            `export expectation evidence could not be persisted: ${bounded(error, "storage failure")}`,
            { cause: error },
          );
    }
    if (this.signal.aborted) return this.interrupted("running", undefined, true);
    const expectationHash = await hashEvidenceFile(expectationsPath, this.signal);
    if (this.signal.aborted) return this.interrupted("running", undefined, true);
    if (expectationHash.sha256 === null) {
      throw new StorageError(
        `export expectation evidence could not be hashed: ${expectationHash.error ?? "unknown error"}`,
      );
    }

    this.expectations = expectations;
    this.selectedMembersValue = [...expectations.selectedMembers];
    this.expectationsEvidencePath = expectationsPath;
    const expectationEvidence: ExpectationEvidence = {
      path: expectationsPath,
      sha256: expectationHash.sha256,
      bytes: expectationHash.bytes,
      completeMembers: expectations.completeMembers.length,
      selectedMembers: expectations.selectedMembers.length,
      nativeImports: expectations.selectedReportableImports.length,
      unmappedMembers: expectations.unmappedMembers.length,
    };
    this.recordPreflightEvidence(input, {
      semanticStatus: "succeeded",
      semanticSummary:
        "The fixed native preflight established complete members, imports, and the selected export set.",
      semanticEvidence: [
        `Complete members: ${String(expectations.completeMembers.length)}.`,
        `Selected members: ${String(expectations.selectedMembers.length)}.`,
        `Selected reportable imports: ${String(expectations.selectedReportableImports.length)}.`,
      ],
      native: nativeEvidence,
      selection,
      expectations: expectationEvidence,
    });
    return { ready: true };
  }

  public markAttempted(): void {
    this.attempted = true;
  }

  /** Attach export expectations to a generic process observation. */
  public enrichObservation(base: ProcessObservation): ProcessObservation {
    return {
      ...base,
      expectedMembers: this.expectations?.completeMembers,
      expectedSelectedMembers: this.selectedMembersValue,
      effectiveOutput: this.destination?.effectiveOutput,
      effectiveOutputRealPath: this.destination?.effectiveRealPath,
    };
  }

  /** Evaluate export completeness and persist the complete adapter detail report. */
  public async evaluate(
    observation: ProcessObservation,
    artifacts: ArtifactInventory,
  ): Promise<EvaluationResult<ExportSemanticData>> {
    const context = this.exportContext();
    if (context === undefined) {
      return {
        status: "unknown",
        rule: EXPORT_RULE,
        summary:
          "Export evaluation was invoked before validated preflight expectations were retained.",
        evidence: ["No retained export expectation context was available."],
        data: null,
      };
    }
    const outcome = await evaluateExport({ observation, artifacts, context });
    if (this.store === undefined) return outcome.evaluation;
    const detailPath = await this.store.writeAuxiliaryJson(
      EXPORT_DETAIL_NAMESPACE,
      "report.json",
      outcome.detail,
    );
    const data = outcome.evaluation.data;
    return {
      ...outcome.evaluation,
      data:
        data === null
          ? null
          : { ...data, reports: { ...data.reports, adapter: detailPath } },
    };
  }

  /**
   * Inventory only the accepted destination when it is operation-owned or
   * exactly revalidated; a requested destination is added only after launch.
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
      roots.push({
        path: destination.effectiveRealPath,
        role: "export-destination",
      });
    }
    return roots;
  }

  /** Separate administrative evidence from editable/raw export output. */
  public interpretInventory(inventory: ArtifactInventory): ArtifactInventory {
    const destination = this.destination;
    if (destination === undefined) return inventory;
    const administrative = exportAdministrativePaths(
      destination.effectiveRealPath,
      this.input.dumpResourceStrings === true,
    );
    const logIdentity = pathIdentity(administrative.log);
    const reportIdentity = pathIdentity(administrative.report);
    const resourceStringsIdentity =
      administrative.resourceStrings === null
        ? null
        : pathIdentity(administrative.resourceStrings);
    const selectedIdentities = new Set<string>();
    const outputRoot = {
      display: destination.effectiveOutput,
      realPath: destination.effectiveRealPath,
    };
    if (this.expectations !== undefined) {
      for (const member of this.expectations.selectedMembers) {
        const file = this.expectations.memberPaths.get(member);
        if (file === undefined) continue;
        const real = normalizeExportOutputPath(file, outputRoot);
        if (real !== null) selectedIdentities.add(pathIdentity(real));
      }
    }
    const outputIdentity = pathIdentity(destination.effectiveRealPath);
    return {
      ...inventory,
      entries: inventory.entries.map((entry) => {
        const identity = pathIdentity(entry.path);
        if (identity === logIdentity) {
          return { ...entry, role: "administrative-log" };
        }
        if (identity === reportIdentity) {
          return { ...entry, role: "administrative-report" };
        }
        if (
          resourceStringsIdentity !== null &&
          identity === resourceStringsIdentity
        ) {
          return { ...entry, role: "administrative-resource-strings" };
        }
        if (selectedIdentities.has(identity)) {
          return { ...entry, role: "selected-raw" };
        }
        if (
          identity === outputIdentity ||
          identity.startsWith(`${outputIdentity}/`)
        ) {
          const relative = identity
            .slice(outputIdentity.length)
            .replace(/^\//u, "");
          return {
            ...entry,
            role: isExportAccompanyingRelative(relative)
              ? "accompanying"
              : "export-artifact",
          };
        }
        return entry;
      }),
    };
  }

  private interrupted(
    stage: Phase,
    message?: string,
    beforeLaunch?: true,
  ): ExportPreparationResult {
    return {
      ready: false,
      stopped: false,
      interrupted: {
        stage,
        ...(message === undefined ? {} : { message }),
        ...(beforeLaunch === true ? { beforeLaunch: true } : {}),
      },
    };
  }

  private rejection(
    code: ErrorCode,
    summary: string,
    evidence: readonly string[],
    status: "failed" | "unknown" = "failed",
  ): ExportPreparationResult {
    return {
      ready: false,
      stopped: false,
      code,
      summary: bounded(summary, "export preflight failed"),
      semantic: {
        status,
        rule: EXPORT_RULE,
        summary: bounded(summary, "export preflight failed"),
        evidence: evidence
          .slice(0, MAX_EVIDENCE)
          .map((line) => bounded(line, "export preflight evidence")),
        data: null,
      },
    };
  }

  private recordPreflightEvidence(
    input: ExportPreparationInput,
    fields: {
      readonly semanticStatus: "succeeded" | "failed" | "unknown" | "not_evaluated";
      readonly semanticSummary: string;
      readonly semanticEvidence: readonly string[];
      readonly native?: NativeEvidence;
      readonly selection?: ExportSelectionOutcome;
      readonly expectations?: ExpectationEvidence;
    },
  ): void {
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
      stdout: { ...input.run.stdout },
      stderr: { ...input.run.stderr },
      semantic: {
        status: fields.semanticStatus,
        rule: EXPORT_RULE,
        summary: bounded(fields.semanticSummary, "export preflight"),
        evidence: fields.semanticEvidence
          .slice(0, MAX_EVIDENCE)
          .map((line) => bounded(line, "export preflight evidence")),
        data: null,
      },
      native: fields.native ?? null,
      selection:
        fields.selection === undefined
          ? null
          : fields.selection.ok
            ? {
                ok: true,
                classification: fields.selection.classification,
                count: fields.selection.members.length,
                sourceKind: fields.selection.sourceKind,
                provenance: fields.selection.provenance,
              }
            : {
                ok: false,
                reason: fields.selection.reason,
                patterns: [...fields.selection.patterns],
                sourceKind: fields.selection.sourceKind,
                provenance: fields.selection.provenance,
              },
      expectations: fields.expectations ?? null,
    };
  }

  private exportContext(): ExportEvaluationContext | undefined {
    if (
      this.expectations === undefined ||
      this.destination === undefined ||
      this.expectationsEvidencePath === null
    ) {
      return undefined;
    }
    const administrative = exportAdministrativePaths(
      this.destination.effectiveOutput,
      this.input.dumpResourceStrings === true,
    );
    return {
      effectiveOutput: this.destination.effectiveOutput,
      effectiveOutputRealPath: this.destination.effectiveRealPath,
      completeMembers: this.expectations.completeMembers,
      selectedMembers: this.expectations.selectedMembers,
      imports: this.expectations.imports.map((entry) => ({
        path: entry.path,
        importMdPath: entry.importMdPath,
        sourceFile: entry.sourceFile,
        importer: entry.importer,
        type: entry.type,
        destFiles: entry.destFiles,
      })),
      nativeReportPath: administrative.report,
      nativeLogPath: administrative.log,
      resourceStringsPath: administrative.resourceStrings,
      nativePreflightPath: exportPreflightEvidencePath(this.operationDirectory),
      expectationsPath: this.expectationsEvidencePath,
      dumpResourceStrings: this.input.dumpResourceStrings === true,
      selection: {
        kind: this.input.selection.kind,
        group:
          this.input.selection.kind === "group"
            ? this.input.selection.group
            : null,
      },
    };
  }
}
