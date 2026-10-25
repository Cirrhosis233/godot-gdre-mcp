# GDRE Execution and Persistence Contract

Developer reference for the **current Windows x64 stdio implementation**. This document describes shared invariants, not a roadmap or complete GDRE CLI coverage. For calls and supported inputs, use [tool usage](tool-usage.md) and the [generated reference](command-reference.md).

- [1. Authority and evidence](#1-authority-and-evidence)
- [2. Registry and typed calls](#2-registry-and-typed-calls)
- [3. Configuration, paths, and destinations](#3-configuration-paths-and-destinations)
- [4. Profiles and sensitive evidence](#4-profiles-and-sensitive-evidence)
- [5. Execution and MCP boundaries](#5-execution-and-mcp-boundaries)
- [6. Results and persistence](#6-results-and-persistence)
- [7. Concurrency and process lifetime](#7-concurrency-and-process-lifetime)
- [8. Runtime health and semantic success](#8-runtime-health-and-semantic-success)
- [9. Dependencies and build](#9-dependencies-and-build)
- [10. Acceptance](#10-acceptance)

## 1. Authority and evidence

The typed [registry](../src/registry.ts) defines registered tools, strict parameters, argument adaptation, annotations, effects, evaluators, and coverage. [Schemas](../src/schemas.ts) define the result and record structures. Probing a different runtime must not rewrite either.

Evidence labels distinguish **S** (inspected source), **R+** (successful runtime fixture), **R-** (observed failure/prerequisite), and **U** (unexecuted behavior). Help text, version agreement, generated metadata, and exit zero alone do not establish support. Acceptance expectations must come from independently known content or observations, not just the descriptor being tested.

Only accepted capabilities are registered. Unregistered commands and rejected parameters carry no compatibility or delivery promise. This contract does not admit caller scripts, arbitrary argv, persistent jobs, network MCP transports, automatic updates, or execution of recovered projects.

## 2. Registry and typed calls

### 2.1 Descriptor responsibilities

Each descriptor supplies identity, input/output schemas, parameter metadata, validation, planning, semantic evaluation, static annotations/effects, and evidence/coverage. Parameter metadata includes path roles, sensitivity, encoding, cardinality, and typed projections of nested host paths. The registry generates tool registration and parameter reference material; prose must not define an alternate parameter contract.

Validation and planning are deterministic: no spawning, scheduling, or manifest writes. Command modules own command-specific preparation and evidence; shared execution owns lifecycle and persistence (§5).

### 2.2 Implemented identities

| Command ID / tool | Execution form and boundary |
| --- | --- |
| `version` / `gdre_version` | Exact injected `--headless --gdre-version` query. |
| `list-files` / `gdre_list_files` | Native listing with admitted literal/glob inputs. |
| `extract` / `gdre_extract` | Raw member extraction with independently derived selection. |
| `export-resources` / `gdre_export_resources` | Filtered native `--recover` with required member/group selection; not full recovery. |
| `patch-translations` / `gdre_patch_translations` | Fixed native script composition writing standalone translation resources. |
| `pck-patch` / `gdre_pck_patch` | Direct native patch of one standalone unencrypted PCK, with ordinary replacements and/or one translation mapping. |

All six admit optional absolute `workspace` and opt-in `timeoutMs`; unknown fields are rejected. Inputs are typed literal paths or, only where supported, adapter filesystem globs. Expansion supports `*`, `?`, and `**`, rejects no-match/duplicate resolved inputs, sorts each expansion by Windows identity, and preserves input-group order. There is no shell, brace, tilde, or environment expansion. Multiple inputs compose one runtime load, not independent operations; unverified overlay precedence is not promised.

Host paths and logical `res://` identities are separate roles. Logical member/resource targets retain exact case and forward-slash identity. Command preparation rejects unsafe, ambiguous, duplicate, or unrepresentable mappings rather than guessing names or native metadata. Per-command limits and accepted formats are in the generated reference and usage guide.

### 2.3 Invocation and session encoding

- CLI application calls use `['--headless','--no-header','--', ...session, ...primaryArgs, ...ordinaryArgs]` in registry order. Selection emits native script/translation modes or ordered member filters.
- The only admitted session action is ordered `{kind:'multithreading', disabled:boolean}`. Explicit `session:[]` clears configured actions. Dedicated boolean parsing is not evidence that generic `--setting` conversion is safe.
- Standalone translation uses the fixed script with operation-owned request/report paths and optional redactable `--key=HEX`. Inputs, mappings, locales, and session actions are typed request data, not caller-selected scripts or raw argv.
- Combined PCK translation emits one `--patch-translations=PREPARED_CSV=res://IMPORT` mapping after ordinary `--patch-file` mappings; `--locales` is emitted only for explicit selection. Original CSV provenance remains separate from its BOM-stripped prepared copy.
- Export hints are protected host files. String-collection/dump flags retain native semantics; a requested dump is conditional, not guaranteed.

The owned Windows launcher receives executable, argv, CWD, and environment separately, without a shell. Its quoting follows Windows `CommandLineToArgvW` rules. Reject parser-altered edge whitespace/quotes and control characters. Native CLI maps additionally reject `=` and single/double quotes in components rather than escape lossily. Standalone translation mappings use JSON and do not inherit CLI-map delimiter restrictions.

### 2.4 Annotations

Set all four static MCP hints explicitly. The version query is read-only, nondestructive, idempotent, and closed-world. Registered application tools retain conservative non-read-only, destructive, non-idempotent, open-world hints. Per-call effects describe actual admitted work; runtime probes and arguments do not dynamically rewrite discovery metadata. Hints are neither sandbox guarantees nor a replacement for host permissions.

## 3. Configuration, paths, and destinations

### 3.1 Sources and precedence

Derive installation root from the installed entry point, never launch CWD. Load optional installation-root `gdre-mcp.config.json`, or the absolute `GDRE_MCP_CONFIG` path. An absent default file uses defaults; invalid explicit configuration prevents startup with stderr diagnostics, not stdout noise. Do not load `.env` automatically.

[Configuration](runtime-provisioning.md#configuration) documents defaults and path resolution. Precedence is built-in < config < documented machine-path environment overrides < explicit call fields. Scalars and arrays replace defaults as a whole. Only `timeoutMs` and applicable ordered `session` are command defaults; keys and input/output paths are call-only.

Internal storage defaults to `<system temp>/GodotGdreMcp/`. Relative host paths are admitted only with an explicitly selected call/config/environment workspace. Never infer a path base from automatic Temp, input location, or CWD. Absolute paths outside the workspace remain supported; it is not a sandbox. Invalid storage or destination selection does not trigger fallback to another root.

### 3.2 Windows identity

Supported storage uses local Windows drive paths in ordinary case-insensitive directories. Reject UNC/device paths, alternate data streams, drive-relative/rooted-without-drive paths, reserved names, trailing dots/spaces, case-sensitive trees, and paths that cannot be safely classified.

Identity uses realpath, normalized separators, drive/case folding, and segment-aware comparisons while preserving display spelling. Resolve new paths through their longest existing ancestor. Revalidate ancestors, input fingerprints, aliases, and destinations before launch; reject uncertain reparse points and unsupported hardlinks. Lowercasing alone does not establish identity or protection against hostile filesystem races.

Each operation gets an exclusively created lowercase UUID directory under `.gdre/operations/`, containing raw/text streams, an initially incomplete `artifacts.json`, a private `profile/`, reserved internal `output/`, and one terminal `manifest.json` if publication succeeds. Never reuse IDs or derive them from a basename, timestamp, or request ID. Records are not automatically deleted or reconciled.

### 3.3 Destinations and inventory

Omitted output uses one unique sibling beside admitted primary inputs, selected after expansion: `<stem>-extracted-<operationId>/`, `<stem>-exported-<operationId>/`, `<stem>-translations-<operationId>/`, or `<stem>-patched-<operationId>.pck`. Directory names remain intact. Same-parent multi-inputs use `gdre-<operation-kind>-<operationId>/`; mixed parents require explicit output. Auxiliary CSVs, hints, replacements, and dependencies never choose the parent. Choose once and revalidate; do not regenerate or fall back after failure.

Explicit output preserves exact resolved destination intent, including accepted junction spelling. `paths.effectiveDestination` is the product; `paths.output` remains internal. Default siblings still undergo external-output checks. Native adjacent logs/reports and PCK `.tmp` files retain their diagnostic roles and failure-retention behavior.

File outputs must not exist; directory outputs must be absent or empty. Reject source/output overlap, input aliases, administrative collisions, and recursive source scans containing the selected workspace metadata. Do not silently omit `.gdre` from a user's source tree. PCK output parents must already exist, and adjacent `.tmp` collisions fail.

Normal success requires accepted complete inventory at declared mutation roots. Record actual paths, roles, kinds, byte counts, SHA-256, and errors without following links/reparse points. Unexpected effects fail acceptance; this is not a whole-machine write monitor. Interrupted/skipped inventory stays incomplete: count zero does not establish no files. Responses sample at most 32 entries and reference full evidence.

## 4. Profiles and sensitive evidence

### 4.1 Operation profiles and safety controls

Application work uses fresh operation-local child `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `HOME`, `TEMP`, `TMP`, and `GDRE_PLUGIN_CACHE_DIR`, with operation-directory CWD. Keep necessary inherited Windows loader/system variables, not a copied user config/cache or full environment record. Environment redirection does not prove every GDRE/plugin/system effect is isolated.

Generate a typed `gdre_settings.cfg` before application startup and retain its hashed pre-start snapshot; GDRE can rewrite the live file on exit. Reserved boolean controls remain false:

- `General/download_plugins`, `General/execute_visual_shader_node_scripts`, `General/delete_auto_converted_files`;
- `Recovery/clear_output_dir_except_git_before_full_recovery`, `Recovery/git/create_git_repo`, `Recovery/git/add_imports_to_git_repo`;
- `CSharp/compile_after_decompile`, `CSharp/verify_nuget_package_is_from_nuget_org`, `CSharp/automatically_search_workshop_dependencies`, `CSharp/copy_out_of_tree_references`.

Config/session fields cannot re-enable these controls. There is no recovered-build or shader-script opt-in. Injected version queries do not need application configuration. Neither profiles nor these settings make native parsing a security sandbox.

### 4.2 Settings admission

The current application settings allowlist is empty; nonempty generic settings and setting session actions are rejected. Keep typed profile serialization distinct from CLI string conversion. In particular, native generic string `false` was observed converting to true, and string arrays were not decoded from CSV/JSON. Do not widen admission based on representability alone or silently change action ordering by moving values into profiles.

### 4.3 Sensitive evidence

Redact descriptor-marked secrets in normal results, manifests, argv previews, and inline diagnostics before truncation. Do not hash low-entropy secrets as a substitute. Record selected safe environment paths, not the full parent environment. CLI secrets can remain visible to local process inspection.

Raw captured streams remain unaltered and may contain native-echoed secrets or sensitive content. Existing workspace access controls apply; there is no encryption-at-rest or secret vault, and arbitrary echoed secrets cannot all be discovered. Treat raw records as private, not sanitized shareable logs. Registered tools do not accept caller scripts or auto-execute recovered files.

## 5. Execution and MCP boundaries

The [MCP module](../src/mcp.ts) registers schemas, forwards cancellation/progress, and maps final results. [Execution](../src/execution.ts) owns config, health, operation allocation, process lifetime, capture, inventory, persistence, and normalized completion. Do not duplicate lifecycle code in tool handlers.

Command-specific responsibilities stay with their modules:

- [Argument adaptation](../src/command-invocation.ts): effective defaults and provenance.
- [Extraction](../src/extraction-operation.ts): destination, listing preflight, independent selection, and interpretation.
- [Export](../src/export-operation.ts): protected hints, metadata preflight, import expectations, reports, and detail.
- [Standalone translation](../src/translation-operation.ts): CSV admission/staging, request/report adaptation, and native transaction evidence.
- [PCK patch](../src/pck-patch-operation.ts): source/replacement fingerprints, native preparation/inspection, byte/member checks, and combined getter verification.

Fixed native scripts use GDRE operations/getters, not alternate encoders, general importers, or caller-controlled execution. Shared execution owns every stage's launch and cancellation.

`openExecution` loads config and health; unavailable runtime is a health state, not invalid configuration. `execute` revalidates constraints and resolves expected operational failures as `OperationResult`. `close` is idempotent, rejects new work, cancels active calls, and awaits registered completion. The latest health snapshot is immutable. Internal composition is not a public adapter framework.

## 6. Results and persistence

### 6.1 Normalized result

The strict [result schema](../src/schemas.ts) is authoritative. Result `schemaVersion:1` includes identity, success/status/error, runtime, timing, process, semantic assessment, paths, stdout/stderr summaries, artifacts, cleanup, persistence, and warnings. `null` means unavailable observation, not invented zero or successful emptiness. Command-specific semantic data does not replace the shared envelope or inline recovered-file contents.

Runtime state records health, registry/target/actual CLI versions, comparison, executable/companion paths and hashes, baseline comparison, check time, startup evidence/probe, and warnings. **PE and embedded-engine versions are not currently recorded.**

Stream previews are bounded to 8192 UTF-8 bytes each. Artifact samples, semantic evidence descriptions, and warnings have maxima of 32; summary/error text is bounded to 2048 UTF-8 bytes per item. Full detail stays in retained files. `queuedAt:null` and `queueMs:0` preserve compatibility; there is no admission queue. Child timestamps reflect actual creation/exit observations, and Windows unsigned exit codes remain intact. `finishedAt`/`totalMs` are prepared before terminal publication and exclude its latency.

MCP returns the command-specific strict output schema, `structuredContent:result`, JSON text content, and `isError:!result.success`. SDK input-schema rejection, unknown tools, and protocol errors can occur before the execution handler and need not have this envelope or a manifest. Storage failures can leave allocated identity with null paths and unavailable persistence. Cancellation/disconnection may suppress delivery even when shutdown persistence is attempted.

### 6.2 Manifest and inventory

`manifest.json` is one terminal record with independent `recordVersion:2`, terminal result fields, state, redacted requested/effective parameters, parameter sources, ordered session, invocation, effects, and command provenance. Invocation records executable/argv/CWD, selected environment-profile paths, and inspected input fingerprints; effects distinguish intended mutation roots, known side-effect roots, and limitations. No event-history projection or stream-hash reread is required.

`artifacts.json` uses `schemaVersion:1`, completeness, entries, and errors. Entries contain path/role/kind, nullable size/hash, and errors. Allocation starts incomplete. Queries can finish with verified complete empty inventories; skipped enumeration stays incomplete. Logs/profiles have administrative roles, not recovered-artifact roles.

There are no running manifests, lifecycle snapshots, corrective publications, old-record reconciliation, resume, or repair. Forced loss may leave files without a terminal record; absence proves neither success nor cleanup.

### 6.3 Durability and storage failure

Allocate exclusive operation/output/profile directories, capture files, and initial inventory before launch. Required prelaunch evidence failure prevents launch. JSON writes use a unique sibling temporary file, flush/close, and atomic same-volume publication; preserve prior files on replacement failure. These are committed local files, not universal power-loss guarantees.

Flush capture and publish available inventory before the single terminal manifest attempt. Running capture failure stops owned work. Required inventory failure prevents success. Terminal publication failure reports incomplete persistence and a bounded diagnostic, not success, detached repair, or a second corrective manifest. Do not claim the persisted record matches a returned failure when its write failed.

### 6.4 Streams and stdout

Capture both child streams concurrently with backpressure into complete raw bytes and incremental UTF-8 display copies. Preserve invalid bytes in raw files; display replacement sets `utf8Valid:false`. Complete means observed EOF and successful capture, not semantic success. No total retained-log cap is imposed; I/O failure stops work rather than silently truncates it.

Redact inline text before bounding. For truncation, include `\n...[truncated]...\n` within the 8192-byte budget, split the remaining budget between head/tail, and preserve Unicode boundaries. Empty capture is not proof GDRE ran. Child output never inherits server stdout: stdout is MCP framing only, stderr is for diagnostics, and progress uses protocol notifications.

## 7. Concurrency and process lifetime

### 7.1 Isolation and coordination

Calls can overlap in one or different workspaces with operation-local arguments, profiles, records, capture, results, and cancellation. Runtime-health refresh may coalesce without serializing whole calls. There is no workspace queue, shared-target reservation, host-wide mutex, or cross-process lock.

Callers coordinate conflicting reads/writes within and across server processes. Retain invocation-local alias/fingerprint/overlap/metadata/destination checks; do not promise conflict detection or require GDRE to reject races. Unconfirmed owned cleanup reports `cleanup_failed` and blocks subsequent launches in that server. Already active calls retain their own ownership. Restart requires operator confirmation that owned children are gone.

### 7.2 Progress and opt-in timeouts

Progress requires a request token, including numeric zero. Emit strictly increasing phase sequence values, no total/percent, and no periodic heartbeat. Notification failure cannot prolong work or prevent cleanup.

All **six public tools** have no implicit operation deadline or preparation SLA. Call `timeoutMs` replaces an explicitly configured command default; either is an opt-in cancellation limit no greater than `timeouts.maxMs` (ceiling 3600000). Retired `timeouts.defaultMs`/`queueMs` are rejected. The timer starts before the first owned process attempt, covers native preflight/work and necessary evaluation, and disarms before terminal publication. It uses the same operation controller and cleanup path as cancellation; disk-write latency is not timed or corrected with a new publication.

Startup health probing separately uses 10000 ms. Helper readiness/compilation, stop, and stream-drain limits are local controls, not an end-to-end finalization SLA. Hosts configure their own request watchdog; phase notifications do not automatically reset it. Record observed cancellation/disconnection, not an invented server timeout.

### 7.3 Cancellation and cleanup

Observe request abort and actual connection closure. Cancelling one call does not cancel another; disconnect cancels all active calls. Check cancellation before allocation, after preparation, and at owned launch so stopped preparation cannot launch later. Disposable protocol-probe server instances must not close the shared execution lifetime. Work remains awaited by the handler, not detached jobs.

The Windows helper creates GDRE with `CreateProcessW` and `PROC_THREAD_ATTRIBUTE_JOB_LIST` inside an operation-local kill-on-close Job **before execution**. No attach-after-start fallback, process-name killing, parent-PID discovery, or adoption of saved PIDs. Native Job membership owns descendants/grandchildren, not arbitrary service/external processes. Node `child.kill()` alone does not provide this ownership.

Typed launch data and stop/EOF travel over a private control pipe. GDRE receives NUL stdin and forwarded stdout/stderr, not control/Job handles. Node exit closes the pipe; helper death closes its non-inherited Job handle. Natural root exit still requires remaining Job cleanup. Root and helper exit codes are distinct; missing status never proves cleanup. Readiness failure cannot become success because later output looks valid.

After observed root exit, a local 15000 ms helper-completion allowance bounds a stuck helper; it is not a running-operation cap. On cancel/timeout/disconnect/shutdown/storage failure, stop further launches, request owned termination, wait up to 5000 ms, retry/escalate once for another 5000 ms, and drain pipes for up to 2000 ms before marking capture incomplete. Failure to confirm cleanup quarantines further launches. Uninterruptible OS/filesystem failures remain outside hard real-time guarantees.

**Stopped evidence policy:** preserve acquired logs, reports, partial files, and available observations. Do not begin exhaustive inventory/hash passes, semantic rescans, detached recovery, or new report parsing after stop merely to finish a record. An in-progress inventory observes cancellation and retains partial evidence. Attempt available inventory and one terminal publication where possible; forced server loss may prevent both.

First observed terminal trigger wins among cancellation, timeout, disconnect, and shutdown. Preserve natural exit observations rather than treating kill-induced codes as normal outcomes. Failure priority is **cleanup_failed > storage_failed > first termination trigger > spawn/process/semantic error**. Retain lower-priority observations. Success requires accepted semantics/evidence, confirmed or unnecessary cleanup, and complete terminal persistence.

## 8. Runtime health and semantic success

### 8.1 Startup and refresh

Provision runtime files as described in [runtime provisioning](runtime-provisioning.md); baseline hashes live in [runtime.ts](../src/runtime.ts). Check all three companions, hash them, and probe `--headless --gdre-version` with the same process ownership and a 10-second limit. Retain full streams and startup JSON under `<workspace>/.gdre/startup/<UUID>/`, separate from user operations. Required startup-evidence storage failure prevents serving; unusable runtime alone leaves fixed tools discoverable.

A usable probe naturally exits 0 or 1 with exactly one `Godot RE Tools v<VERSION>` line after newline/optional BOM normalization, complete capture, and no spawn/timeout/cleanup/loader-error evidence. The recorded baseline naturally exits **1**, which is successful. Compare the CLI version without altering prerelease/build suffixes or case. Version/hash mismatch warns, not blocks; it never rewrites registry schemas. Registry baseline remains `2.8.0-beta.2` independently of configured targetVersion.

Each valid call rechecks companion identity; changed identity refreshes health. A later explicit call may retry unavailable health; there is no automatic update/download loop. Version calls execute the real query again, not cached startup text. A successful probe is not proof every native operation is compatible.

### 8.2 Command-specific evidence

| Tool | Required semantic evidence |
| --- | --- |
| Version | Natural exit 0/1, recognized exact version line, complete capture, and accepted cleanup. |
| List | Corroborated loads, consistent parsed members/total, and no load errors. Empty output alone does not establish a valid empty package. |
| Extract | Independent full/selected preflight expectations, exact selected artifacts, and observed default checksum coverage. |
| Selected export | Nonempty selection, native import mapping/report, verified primary editable files, and `completeness:complete`. Raw copies or scaffolding are not editable success. |
| Standalone translation | Valid native transaction report plus requested/retained text and resource/locale verification backed by complete inventory. |
| PCK patch | Accepted marker/exit, complete inspections, inherited metadata, exact replacement/retained bytes, unchanged inputs, and accepted inventory; combined mode adds native translation/config verification. |

Unknown is not success. Application artifact operations normally require natural exit zero plus their semantic checks. Error diagnostics can invalidate exit zero; warnings alone do not establish failure. Evaluators are not universal content or game-compatibility oracles.

#### Extraction and export

Retain full extraction expectations independently of public listing samples and actual output. Selection uses the [documented asymmetric pattern semantics](tool-usage.md#extracting-a-controlled-input). Empty selections fail before native fallback. Default PCK checksum scope is the full loaded set, including excluded members; corroborated non-PCK graphs can have not-applicable coverage. Keep selected counts separate from checksum counts.

Export preflight maps real logical selected members to imports through native getters. Several locales can map to one CSV. Require native report entries and hashed primary editable output; missing/partial/unsupported imports remain visible. Keep raw members, metadata, scaffolding, and administrative reports distinct. A generated project file is not complete recovery.

#### Standalone and combined translations

CSV admission requires strict UTF-8/quoting, one key column, unique known keys/locales, and consistent widths. Preserve originals; stage only an initial-BOM-stripped copy and record native CRLF normalization. Resource mappings identify actual logical import sources. Explicit locales are exact; omission means new locales only, never all-locales fallback. Unresolved keys, unconfirmable empty original lookups, and unsupported metadata fail rather than guess.

Standalone success verifies native output content/identity against inventory. Native-reported files absent from verified outputs remain unverified, including possible project config; acquired failure file maps can establish partial output, not success.

Combined preparation derives default-locale/import/generated-path/config identities before mutation and rejects collisions with ordinary targets or config. Text and binary project configs use native getters, binary precedence, and verified registration or actual absence. Mutation remains one direct native CLI invocation. Member sets can add only preparation-approved new-locale destinations; ordinary replacements and untouched members require exact bytes. Selected regenerated translations/config instead require independent getter checks for class/locale/path, every requested text, retained message multisets, and registration/absence. Original and prepared CSVs and other inputs must remain unchanged.

Combined native `.tmp_translations` is profile-local and retained without immediate-deletion guarantees. Known failure with acquired file observations is partial, otherwise failed; stop is unknown. Natural failure can consume its bounded rejection report; stopped work does not parse a newly acquired report or run exhaustive audits. Controlled unencrypted format-2/engine-4.4.0 fixtures establish this slice, not arbitrary-format/encrypted support, a general serializer, or game loading.

## 9. Dependencies and build

### 9.1 Supported baseline

Support **Node 24.x** on Windows x64 (`engines.node: ^24.0.0`), with Node 24 types. [ADR 0001](adr/0001-node-24-baseline.md) records the single-line decision. The tracked package/lockfile pin split `@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.3.1 with a direct compatible Zod dependency. Do not substitute the legacy SDK package or rely on transitive imports. A dependency minimum is not an expanded product support claim.

### 9.2 SDK seam

Use the connection-owned `serveStdio` factory and existing imports in [stdio.ts](../src/stdio.ts) and [mcp.ts](../src/mcp.ts). The SDK provides schema handling, request cancellation/progress, and transport closure; it does not own native descendants, storage, semantics, or host permissions. Connect closure and SIGINT/SIGTERM to execution shutdown. SDK cancellation can discard later responses while cleanup/persistence still need completion.

Do not claim interoperability with a host/protocol era solely from SDK version. Verify actual initialization, discovery, calls, and disconnect behavior. See the pinned [stdio documentation](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/docs/serving/stdio.md), [tool schemas](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/docs/servers/tools.md), and [client calling guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/docs/clients/calling.md).

### 9.3 Build arrangement

Keep the private ESM TypeScript package, strict NodeNext configuration, tracked lockfile, and `dist/src`/`dist/test` output layout. [Development](development.md) lists build/test/reference commands. GDRE remains separately provisioned; building the adapter does not build or redistribute GDRE. No bundler, monorepo, web server, or automatic runtime installer is required by the current product.

## 10. Acceptance

### 10.1 Version-call baseline

[Production stdio tests](../test/stdio.test.ts) discover and call `gdre_version` with strict schemas, exact argv, actual CLI version, and accepted natural exit 1 for the recorded baseline. Successful queries have complete empty product inventories, no effective destination, and distinct terminal records. Cover missing runtime, mismatch warnings without schema changes, CWD-independent config, malformed input, and clean MCP stdout.

### 10.2 Capability and shared-interface checks

Run focused checks while editing and the full [development checks](development.md) at completion. Keep expected operational errors in passing assertions, not red default tests or skipped runtime acceptance. Representative evidence:

- [Lifecycle](../test/lifecycle.test.ts), [execution lifecycle](../test/execution-lifecycle.test.ts), and [planner/artifacts](../test/execution-plan-artifacts.test.ts): failures, timeout/cancellation, storage, final-only records, and incomplete evidence.
- [Native ownership](../test/process-tree.test.ts) and [stdio lifecycle](../test/stdio-lifecycle.test.ts): descendants, unrelated-process survival, pipe EOF, helper/Node death, and protocol-probe disposal. Wait for observed ownership rather than guessed startup sleeps.
- [Concurrency stdio](../test/concurrency-stdio.test.ts): overlapping operation isolation with a substituted runtime; not a replacement for real content fixtures.
- [Extraction](../test/extraction-stdio.test.ts), [input matrix](../test/extraction-inputs-stdio.test.ts), and [selection](../test/extraction-selection-stdio.test.ts): independent member bytes, layouts, filtering, checksum scope, and bounded results.
- [Export stdio](../test/export-stdio.test.ts): known editable CSV/script content.
- [Native translations](../test/translation-native.test.ts) and [translation stdio](../test/patch-translations-stdio.test.ts): known Unicode keys/text/locales, correct/wrong keys, original preservation, and partial failures.
- [Native PCK patch](../test/pck-patch-native.test.ts) and [runtime stdio](../test/pck-patch-runtime-stdio.test.ts): authored package headers/members and independent content checks.
- [Native combined patch](../test/pck-patch-combined-native.test.ts) and [combined runtime stdio](../test/pck-patch-combined-runtime-stdio.test.ts): combined bytes, locale/config getter evidence, and fixture limits.

New capabilities require independently checkable content/effect fixtures and updates to affected consumers, schema/reference, and lifecycle coverage. Internal fault seams can exercise reproducible process/storage failures, not replace real-runtime acceptance or add test-only public tools. These checks establish bounded local behavior, not a hard finalization SLA or universal compatibility.
