# GDRE Command Reference

This file is generated from the typed command registry. Do not edit it by hand.
See [tool usage](tool-usage.md) for examples and [development](development.md) for regeneration commands.

Expandable evidence sections use **S** for inspected source, **R+** for successful runtime fixtures, **R-** for observed failures/prerequisites, and **U** for unexecuted behavior. Fixture coverage does not imply support for every upstream format or option.

Registry entries: 6

## Registered tools

| ID | Tool | Category | CLI spelling | Invocation argv |
| --- | --- | --- | --- | --- |
| `version` | [`gdre_version`](#gdre_version) | `runtime` | `--gdre-version`, `--version` | `["--headless","--gdre-version"]` |
| `list-files` | [`gdre_list_files`](#gdre_list_files) | `application` | `--list-files` | `prefix ["--headless","--no-header","--"] + mapped arguments` |
| `extract` | [`gdre_extract`](#gdre_extract) | `application` | `--extract` | `prefix ["--headless","--no-header","--"] + mapped arguments` |
| `export-resources` | [`gdre_export_resources`](#gdre_export_resources) | `application` | `--recover` | `prefix ["--headless","--no-header","--"] + mapped arguments` |
| `patch-translations` | [`gdre_patch_translations`](#gdre_patch_translations) | `application` | `--script` | `prefix ["--headless","--script"] + mapped arguments` |
| `pck-patch` | [`gdre_pck_patch`](#gdre_pck_patch) | `application` | `--pck-patch` | `prefix ["--headless","--no-header","--"] + mapped arguments` |

### gdre_version

Report the fixed GDRE Tools runtime version without loading a project or accepting arbitrary CLI arguments.

- Canonical ID: `version`
- Category: `runtime`
- Routing: `injected`
- CLI spellings: `--gdre-version`, `--version`
- Exact argv: `["--headless","--gdre-version"]`
- MCP annotations: read-only=true, destructive=false, idempotent=true, open-world=false

#### Parameters

| Parameter | Type | Required | Description | Encoding |
| --- | --- | --- | --- | --- |
| workspace | string | no | Optional absolute workspace selector. Relative, UNC, device, and drive-relative paths are rejected. | absolute local Windows drive path |
| timeoutMs | integer | no | Optional caller-selected cancellation budget, at most 3600000 ms. There is no implicit operation timeout. | positive safe integer milliseconds, bounded at 3600000 |

#### Declared effects

- Reads: `the configured GDRE runtime executable and companion files`
- Writes: `operation logs, manifest, and artifact inventory`
- Network: false
- Code execution: false
- Unknown scope: false

<details>
<summary>Evidence and coverage</summary>

- [S] [docs/operation-contract.md](../docs/operation-contract.md) §2.2 and §10.1 — The version query emits the injected --gdre-version spelling.
- [R+] [test/stdio.test.ts](../test/stdio.test.ts) — real stdio version acceptance — The fixed packaged runtime printed `Godot RE Tools v2.8.0-beta.2` and naturally exited 1; both were accepted.

Fixture IDs: `version-line-v1`

##### Constraints

- strict input object rejects unknown keys
- workspace is an absolute local Windows drive path when supplied
- timeoutMs is a positive integer no greater than 3600000
- argv is exactly --headless followed by --gdre-version
- natural exit code 0 or 1 with one recognized version line is semantic success

##### Prerequisites

- fixed GDRE runtime executable and companion files

</details>

### gdre_list_files

List package/project members from admitted inputs using complete retained GDRE evidence; package members are not filesystem artifacts and this operation is not a security sandbox.

- Canonical ID: `list-files`
- Category: `application`
- Routing: `application`
- CLI spellings: `--list-files`
- Application argv prefix: `["--headless","--no-header","--"]`; append ordered session actions, repeated mapped primary arguments, and applicable ordinary fields as described by the parameter contract.
- MCP annotations: read-only=false, destructive=true, idempotent=false, open-world=true

#### Parameters

| Parameter | Type | Required | Description | Encoding |
| --- | --- | --- | --- | --- |
| inputs | array | yes | Nonempty ordered input groups. Literal paths and adapter-expanded glob patterns are distinguished explicitly. | ordered discriminated path/glob values; literals may contain spaces, Unicode, and inline = |
| key | string | no | Optional 64-hex decryption key. Presence does not imply generalized encryption support. | exactly 64 hexadecimal characters; normalized lowercase and redacted by execution |
| session | array | no | Optional ordered session controls. Only the fixture-verified multithreading action is admitted in this slice. | ordered multithreading actions only; each emits a dedicated boolean token |
| workspace | string | no | Optional absolute internal workspace and relative host-path base. Omission uses configured workspace or automatic Temp; automatic Temp requires absolute host paths. | absolute local Windows drive path |
| timeoutMs | integer | no | Optional caller-selected cancellation budget. There is no implicit listing timeout. | positive safe integer milliseconds, bounded at 3600000 |

#### Declared effects

- Reads: `the admitted listing input paths`
- Writes: `operation logs, retained stdout/stderr evidence, manifest, and artifact inventory`
- Network: false
- Code execution: false
- Unknown scope: false

<details>
<summary>Evidence and coverage</summary>

- [S] [docs/operation-contract.md](../docs/operation-contract.md) §2.2, §2.3, and §8.2 — Application listing emits ordered session arguments followed by repeated --list-files paths and requires complete semantic evidence.
- [R+] [test/listing-stdio.test.ts](../test/listing-stdio.test.ts) — real stdio listing acceptance — Independently authored fixture calls cover PCK formats 0–4, ZIP/APK, marked directories, controlled bundle layouts, sidecar selection, XAPK listing, and one encrypted listing with explicit negative cases.

Fixture IDs: `list-files-v1`, `list-files-complete-evidence-v1`

##### Constraints

- strict input object rejects output/include/exclude, generic settings, cache, loader, and unknown fields
- inputs are nonempty ordered path/glob discriminated values; wildcard literals are rejected
- inputs are capped at 256 groups, session is capped at 64 actions, and each input value is capped at 2048 UTF-8 bytes
- key is exactly 64 hexadecimal characters and normalized lowercase
- only ordered multithreading session actions are admitted
- argv is --headless --no-header -- followed by session, repeated resolved --list-files paths, then key
- semantic success requires one complete valid listing section, matching count, natural exit 0, and no load errors
- semantic data contains only a bounded member sample and complete stdout evidence reference

##### Prerequisites

- tracked listing fixture helper, fixed runtime, and real stdio acceptance tests

</details>

### gdre_extract

Extract package contents to an exact accepted destination using ordered include/exclude patterns or all/scripts/translations selection with default checksum verification. Supplied-key and checksum-override fields remain deferred and rejected until their own slices are accepted.

- Canonical ID: `extract`
- Category: `application`
- Routing: `application`
- CLI spellings: `--extract`
- Application argv prefix: `["--headless","--no-header","--"]`; append ordered session actions, repeated mapped primary arguments, and applicable ordinary fields as described by the parameter contract.
- MCP annotations: read-only=false, destructive=true, idempotent=false, open-world=true

#### Parameters

| Parameter | Type | Required | Description | Encoding |
| --- | --- | --- | --- | --- |
| inputs | array | yes | Nonempty ordered input groups. Literal paths and adapter-expanded glob patterns are distinguished explicitly. | ordered discriminated path/glob values; literals may contain spaces, Unicode, and inline = |
| output | string | no | Optional exact extraction destination. Omission uses a unique extracted sibling directory beside same-parent primary inputs; different input parents require output. | literal absolute host path, or relative path with an explicitly selected workspace; no wildcards, parser-significant edge quotes, or shell/environment expansion |
| include | array | no | Optional ordered include patterns. Filesystem-style matching: * and ? do not cross '/', and ** matches zero or more path segments. A bare *.ext pattern (a * with no separator and no **) matches the whole tree. | ordered res://, root-relative, or relative logical glob patterns capped at 256 entries; * and ? wildcards and whole-segment ** only |
| exclude | array | no | Optional ordered exclude patterns applied to the include/all result. The fixed runtime matches excludes as an anchored regex where * crosses '/', so exclude matching is intentionally not the complement of include matching. | ordered logical glob patterns capped at 256 entries; anchored regex semantics where * crosses '/' |
| selection | string | no | Optional member selection mode. Defaults to all. scripts selects gd/gdc/gde and translations selects translation/xl by case-insensitive extension; a non-all mode cannot be combined with include or exclude. | one of all, scripts, translations; scripts emits --scripts-only and translations emits --translation-only |
| session | array | no | Optional ordered session controls. Only the fixture-verified multithreading action is admitted in this slice. | ordered multithreading actions only; each emits a dedicated boolean token |
| workspace | string | no | Optional absolute internal workspace and relative host-path base. Omission uses configured workspace or automatic Temp; automatic Temp requires absolute host paths. | absolute local Windows drive path |
| timeoutMs | integer | no | Optional caller-selected cancellation budget. There is no implicit extraction timeout. | positive safe integer milliseconds, bounded at 3600000 |

#### Declared effects

- Reads: `the admitted extraction input paths`
- Writes: `the exact accepted extraction destination and operation logs, manifest, and artifact inventory`
- Network: false
- Code execution: false
- Unknown scope: false

<details>
<summary>Evidence and coverage</summary>

- [S] [docs/operation-contract.md](../docs/operation-contract.md) §2.2, §2.3, §3.1, §3.3, and §8.2 — Extraction emits the application prefix, ordered session actions, repeated absolute --extract inputs, then --output; default checksum verification emits no override flag.
- [R+] [test/extraction-stdio.test.ts](../test/extraction-stdio.test.ts) — real stdio extraction tracer — One independently authored unencrypted PCK was extracted through the production stdio tool; exact member bytes/SHA-256, destination, separately inventoried administrative log, complete inventory, retained preflight evidence, and generated safety configuration were verified.
- [R+] [test/extraction-inputs-stdio.test.ts](../test/extraction-inputs-stdio.test.ts) — real stdio extraction input matrix — Command-specific extraction verifies independently expected bytes for PCK formats 0–4, stored ZIP, assets-only APK, XAPK, marked directories, controlled .app layouts, and executable sidecars, with explicit destinations, ordered/disjoint multi-inputs, globs, session replacement, and complete bounded artifact evidence.
- [R+] [test/extraction-selection-stdio.test.ts](../test/extraction-selection-stdio.test.ts) — real stdio selected extraction — Independently authored fixtures verify exact filtered and script/translation outputs, ordered overlapping includes with excludes, full versus selected expectation records, full-pack checksum coverage when selecting one of three members, excluded invalid-MD5 failure, no-match safety, directory-filter limits, and bounded responses with complete selected inventories.

Fixture IDs: `extract-tracer-v1`, `extract-input-matrix-v1`, `extract-selection-v1`

##### Constraints

- strict input object admits only inputs, output, ordered include/exclude patterns, all/scripts/translations selection, workspace, timeoutMs, and ordered multithreading session actions
- key and checksum are deferred planned options and are rejected rather than accepted and ignored
- include/exclude patterns are logical res://, root-relative, or relative forms using only * ? and whole-segment **, capped at 256 entries each; brackets, braces, drive/UNC prefixes, parser-significant edge quotes/whitespace, shell/environment expansion, and .. traversal are rejected
- selection=scripts|translations cannot be combined with nonempty include or exclude patterns; extension matching is case-insensitive
- directory-source filters admit only bare-star patterns without a separator or **; unsupported filters retain an incomplete selected expectation rather than claiming a complete empty set
- inputs are nonempty ordered path/glob discriminated values capped at 256 groups, session is capped at 64 actions, and each input value is capped at 2048 UTF-8 bytes
- output is a literal path without wildcards, parser-significant edge quotes, or shell/environment expansion; omission uses a unique input-adjacent sibling directory and requires same-parent primary inputs
- checksum verification remains the default and emits no key or checksum override flags; no universal PCK MD5 coverage is claimed
- argv is --headless --no-header -- followed by ordered session actions, repeated resolved --extract paths, --output=effectiveOutput, repeated --include/--exclude in caller order, then the optional --scripts-only/--translation-only mode flag
- expected selected members are derived from the complete res:// member set with filesystem-style includes and anchored-regex excludes; an empty selected set is a no-match classification rather than the runtime's extract-everything fallback
- an internal --list-files preflight retains the complete member set and is evaluated against the prepared input graph before any extraction write
- semantic success requires corroborated extractor loads, exact expected member paths, exact regular-file/ancestor-directory inventory, present hashes, natural exit 0, honest default checksum verification/skip evidence, and an anchored extraction completion marker
- destinations must be absent or empty; per-invocation path checks and pre-launch revalidation reject input/output overlap, metadata recursion, unsafe Windows members, and runtime-log collisions; conflicting file use between calls is caller responsibility, not a shared-target reservation guarantee
- complete inventory includes the administrative gdre_export.log with a separate role; response projections contain at most 32 entries and failed/cancelled operations retain available partial output
- accepted non-encrypted fixtures cover PCK formats 0–4, stored ZIP, assets-only APK, XAPK, marked directories, controlled single-pack .app layouts, and executable sidecar selection
- embedded executables, IPA, valid empty packs, multi-pack .app layouts, overlay precedence, supplied keys, uncertain/reparse subtrees, UNC/case-sensitive paths, and cross-process coordination remain gated

##### Prerequisites

- fixed local Windows runtime and command-specific fixture evidence; extraction does not imply imported-resource recovery or safe execution of extracted material

</details>

### gdre_export_resources

Export an explicitly selected package/project member set or native scripts/translations group to an exact accepted destination as editable resources, with complete/partial/unsupported/failed completeness, retained native evidence and bounded diagnostics. This is not complete project recovery, raw extraction, inverse import, or a security sandbox.

- Canonical ID: `export-resources`
- Category: `application`
- Routing: `application`
- CLI spellings: `--recover`
- Application argv prefix: `["--headless","--no-header","--"]`; append ordered session actions, repeated mapped primary arguments, and applicable ordinary fields as described by the parameter contract.
- MCP annotations: read-only=false, destructive=true, idempotent=false, open-world=true

#### Parameters

| Parameter | Type | Required | Description | Encoding |
| --- | --- | --- | --- | --- |
| inputs | array | yes | Nonempty ordered package/project input groups. Literal paths and adapter-expanded glob patterns are distinguished explicitly. | ordered discriminated path/glob values; literals may contain spaces, Unicode, and inline = |
| output | string | no | Optional exact export destination. Omission uses a unique exported sibling directory beside same-parent primary inputs; hints do not choose the parent. Different input parents require output. | literal absolute host path, or relative path with an explicitly selected workspace; no wildcards, parser-significant edge quotes, or shell/environment expansion |
| selection | object | yes | Required explicit member-pattern or native group selection. There is no all/default mode and no excludes-only form, so omitted, invalid, empty, or no-match selections never request full recovery. | discriminated object: {kind:members, include: nonempty ordered logical globs, exclude?: ordered globs} or {kind:group, group: scripts\|translations} |
| session | array | no | Optional ordered session controls. Only the fixture-verified multithreading action is admitted in this slice. | ordered multithreading actions only; each emits a dedicated boolean token |
| translationHints | array | no | Optional literal host files loaded as protected translation-key hints. They are separate fingerprinted inputs, never recovery primaries, and are revalidated before launch. | ordered literal host-file paths without wildcards; resolved and fingerprinted separately from recovery primaries |
| collectResourceStrings | boolean | no | Collect project resource strings for translation-key recovery. The typed default preserves the native collect path rather than silently skipping string collection. | boolean; omitted means true, and only an explicit false emits the native skip flag |
| dumpResourceStrings | boolean | no | Write the native resource-string dump during translation key recovery. The emitted dump is classified as administrative evidence. | boolean; omitted means false, and true emits the native dump flag |
| workspace | string | no | Optional absolute internal workspace and relative host-path base. Omission uses configured workspace or automatic Temp; automatic Temp requires absolute host paths. | absolute local Windows drive path |
| timeoutMs | integer | no | Optional caller-selected cancellation budget. There is no implicit export timeout. | positive safe integer milliseconds, bounded at 3600000 |

#### Declared effects

- Reads: `the admitted package/project input paths, protected translation-hint files, and the fixed native preflight inspector`
- Writes: `the accepted export destination, retained export-preflight evidence, adapter expectations and detail reports, and operation logs, manifest, and artifact inventory`
- Network: false
- Code execution: false
- Unknown scope: false

<details>
<summary>Evidence and coverage</summary>

- [S] [docs/operation-contract.md](../docs/operation-contract.md) §2.2, §3.1, and §8.2 — The export operation emits the shared application prefix, ordered session actions, repeated absolute --recover inputs, an explicit --output destination, typed selection flags, optional protected hints, and internal JSON report writing.
- [S] [native/gdre-export-preflight.gd](../native/gdre-export-preflight.gd) and [src/export-operation.ts](../src/export-operation.ts) — A fixed native inspector loads the admitted inputs with existing native getters and retains complete logical member/import metadata before any recovery; selection, expectations and report interpretation remain operation-local.
- [R+] [test/export-stdio.test.ts](../test/export-stdio.test.ts) — selected editable-resource export acceptance — The production MCP/stdio tool exported exact authored translation CSV and decompiled script content from controlled packages and project directories, with explicit/group selection, no-match protection, protected hints/string controls, complete/partial/unsupported/failed outcomes, original preservation and bounded samples backed by complete reports.

Fixture IDs: `export-preflight-v1`, `export-selection-v1`, `export-stdio-v1`

##### Constraints

- selection is required and discriminated: nonempty ordered include patterns or a scripts/translations native group; there is no all/default or excludes-only mode, and empty or no-match selections fail before recovery
- inputs are nonempty ordered path/glob values; output is a literal path and an omitted output is operation-owned and explicitly supplied
- translationHints are separate protected regular-file inputs, not recovery primaries; collectResourceStrings defaults true and dumpResourceStrings defaults false
- key and checksum overrides are rejected and encrypted export is not claimed
- argv is --headless --no-header -- followed by ordered session actions, repeated resolved --recover paths, --output=effectiveOutput, selection flags, repeated --translation-hint paths, string controls, and --setting=write_json_report=true
- a fixed native preflight retains complete logical member/import metadata and derived expectations; unsafe metadata, directory-filter limits and administrative collisions are rejected before mutation
- semantic success requires a complete native report, a verified regular hashed native log and editable artifacts under the accepted destination, and no contradictory failures or missing keys; raw copies and scaffolding are not editable exports
- complete, partial, unsupported, failed and unknown requested-export completeness is reported with bounded diagnostics and references to complete native/adapter evidence
- destinations must be absent or empty; input/hint/destination overlap is rejected before launch; conflicting file use between calls remains caller responsibility, not a shared-target reservation guarantee

##### Prerequisites

- fixed local Windows GDRE runtime, the adapter-owned native inspector, and production MCP/stdio acceptance with authored translation/script content
- controlled authored fixtures with independently known content; no sample-game or third-party assets required

</details>

### gdre_patch_translations

Patch standalone translations through one fixed trusted native script: map edited host CSVs to exact logical import sources, honor explicit locales or native new-locales-only omission, and report verified text/resource evidence. Production MCP/stdio evidence covers retained content, report-backed failures, binary project config, alternate safe resource suffixes and operation-local profile isolation.

- Canonical ID: `patch-translations`
- Category: `application`
- Routing: `application`
- CLI spellings: `--script`
- Fixed native composition: `["--headless","--script"]` followed by the adapter-owned script, `--`, operation-owned request/report paths, and an optional redacted key token. Inputs, translation mappings and ordered session actions are carried by the prepared request, not caller-controlled argv.
- MCP annotations: read-only=false, destructive=true, idempotent=false, open-world=true

#### Parameters

| Parameter | Type | Required | Description | Encoding |
| --- | --- | --- | --- | --- |
| inputs | array | yes | Nonempty ordered literal package/project inputs loaded as one composed project graph. No glob expansion is admitted until separately verified for this operation. | ordered discriminated {kind:path,path} values only; literals may contain spaces, Unicode, and inline =; glob forms are not admitted |
| translations | array | yes | Nonempty ordered edited-CSV to original translation-resource mappings. Externally ambiguous repeated CSV spellings and case-folded duplicate logical targets are rejected before planning. | ordered {csv: protected host path, resource: exact res:// logical import source} objects; no normalization, globs, or host resource filenames |
| output | string | no | Optional exact translation destination. Omission uses a unique translations sibling directory beside same-parent package/project inputs, not the CSV; different input parents require output. | literal absolute host path, or relative path with an explicitly selected workspace; no wildcards, parser-significant edge quotes, or shell/environment expansion |
| locales | array | no | Optional exact locale columns to patch. Omission preserves the native new-locales-only behavior; there is no invented all-locales expansion. Explicit locales must exist as CSV columns at the content gate. | ordered nonempty exact locale identifiers without whitespace, commas, or duplicates |
| key | string | no | Optional 64-hex key for the command-specific encrypted standalone route. Presence does not widen encryption support to other commands. | exactly 64 hexadecimal characters; normalized lowercase, redacted by execution, and never stored in the request or report |
| session | array | no | Optional ordered session controls. Only the fixture-verified multithreading action is admitted; the fixed script applies it through the safe native setting and the manifest preserves the ordered actions. | ordered multithreading actions only; each applies the reserved native boolean setting through the prepared request, not a free argv field |
| workspace | string | no | Optional absolute internal workspace and relative host-path base. Omission uses configured workspace or automatic Temp; automatic Temp requires absolute host paths. | absolute local Windows drive path |
| timeoutMs | integer | no | Optional caller-selected cancellation budget. There is no implicit translation-patch timeout. | positive safe integer milliseconds, bounded at 3600000 |

#### Declared effects

- Reads: `the admitted package/project input paths, resolved original translation CSV files, and the fixed native translation-patch script`
- Writes: `the accepted translation output destination, operation-local prepared CSV copies/request/report/detail evidence, and operation logs, manifest, and artifact inventory`
- Network: false
- Code execution: false
- Unknown scope: false

<details>
<summary>Evidence and coverage</summary>

- [S] [docs/operation-contract.md](../docs/operation-contract.md) §2.2, §2.3, and §8.2 — The standalone translation identity admits literal package inputs, exact ordered CSV-to-original-resource mappings, optional output, explicit locales, a 64-hex key, multithreading session, workspace, and opt-in timeout. Omission keeps the native new-locales-only meaning.
- [S] [src/schemas.ts](../src/schemas.ts) and [src/translation-planning.ts](../src/translation-planning.ts) — Admission rejects glob inputs, non-res:// or unsafe logical targets, raw repeated CSV spellings, case-folded duplicate targets, duplicate locales, and recovery controls before planning. The planner emits one fixed trusted native script launch and refuses missing or contradictory resolved context.
- [R+] [test/patch-translations-stdio.test.ts](../test/patch-translations-stdio.test.ts) and [test/support/translation-fixtures.ts](../test/support/translation-fixtures.ts) — Production MCP/stdio with an encrypted format-2/engine-4.4 PCK verified the correct key patches and reads exact requested text, while a wrong key fails with actionable native load diagnostics. The key never appears in the request, report, manifest, preparation/detail evidence or ordinary results.
- [R+] [test/patch-translations-stdio.test.ts](../test/patch-translations-stdio.test.ts) and [test/support/translation-fixtures.ts](../test/support/translation-fixtures.ts) — Production MCP/stdio on controlled optimized-translation fixtures verified explicit/omitted locale semantics, retained default content, empty replacement text, pre-mutation all-mapping rejection, profile-local side effects, complete inventory/hash evidence, binary project config and report-derived alternate-suffix artifact roles.

Fixture IDs: `translation-standalone-v1`, `translation-encrypted-stdio-v1`

##### Constraints

- strict input object admits only nonempty literal path inputs, nonempty ordered translations, optional output, explicit unique locales, a 64-hex key, multithreading session, workspace, and timeoutMs; globs, hints, string controls, checksum, and unknown fields are rejected
- inputs are literal {kind:path,path} values only; wildcard/glob forms are not admitted before command-specific verification
- translations are capped at 256 ordered mappings; resources must be exact forward-slash res:// logical import sources with nonempty segments and no .., drive, wildcard, control, or edge-whitespace characters
- raw repeated CSV spellings and case-folded duplicate logical targets are rejected; preparation also rejects canonical CSV aliases and malformed CSV content
- locales are capped at 256 nonempty identifiers without whitespace, commas, or duplicates; omission keeps native new-locales-only semantics and never expands to all locales
- key is exactly 64 hexadecimal characters, normalized lowercase, redacted through invocation/records, and never written into request or report JSON
- argv is one fixed trusted launch: --headless --script FIXED -- REQUEST_JSON REPORT_JSON [--key=HEX]; ordered session actions are applied by the script rather than emitted as caller-controlled flags
- the planner requires resolved absolute package inputs, one resolved CSV/resource pair per admitted mapping, an effective absolute output, and the adapter-owned fixed script path; it fails rather than inventing defaults
- the host writes an operation-local key-free request, strips only an initial UTF-8 BOM into prepared copies, preserves original/package bytes and revalidates CSVs, prepared copies and the destination before launch
- success requires a complete strictly shaped native report that corresponds to the request, verified in-destination output hashes/inventory and no contradictory native diagnostics; exit 0 is report delivery only
- missing/malformed/contradictory/ok:false reports are classified before any output inventory; only a valid success-shaped report reaches the existing inventory/hash checks, and structured native failures project only native-acquired evidence
- explicit locales produce exactly the requested output locales; omission derives only new locales, fails when there is no new target, and never expands to all locales; empty replacement text is valid for a confirmed source key
- artifact roles use the native report's actual output identities, so safe destinations such as .godot/imported/*.res remain translation outputs rather than suffix-guessed accompanying files
- operation-local destination absence/collision checks apply, and prior export-operation output CSVs remain usable while the current operation administrative tree is rejected

##### Prerequisites

- tracked controlled optimized-translation fixtures, the fixed local Windows GDRE runtime and the adapter-owned native patch script provide production MCP/stdio evidence; no game assets are required
- encrypted format-2/engine-4.4 PCK evidence covers command-specific key support only; no encryption support is inferred for other commands

</details>

### gdre_pck_patch

Execute ordinary existing-member replacements in one standalone unencrypted PCK through the native CLI, fixed read-only inspections and exact replacement/retained content verification, writing a separate output package. Combined requests add one typed CSV-to-exact-logical-import-source translation mapping with exact locale controls, alone or with ordinary replacements: the adapter stages an operation-owned BOM-stripped CSV, derives native import/default-locale/generated destinations and project registration with a fixed read-only preparation script before mutation, then requires an independent native getter verification of the output. Omitted output uses a unique patched PCK beside the source for both ordinary and combined calls. Keys, filters, embedding, new ordinary members and caller scripts are unsupported; exit zero or output existence alone is not success.

- Canonical ID: `pck-patch`
- Category: `application`
- Routing: `application`
- CLI spellings: `--pck-patch`
- Application argv prefix: `["--headless","--no-header","--"]`; append ordered session actions, repeated mapped primary arguments, and applicable ordinary fields as described by the parameter contract.
- MCP annotations: read-only=false, destructive=true, idempotent=false, open-world=true

#### Parameters

| Parameter | Type | Required | Description | Encoding |
| --- | --- | --- | --- | --- |
| source | string | yes | One source package file to rewrite. It is not a glob, input array, or extraction-style selection. | one literal host file path; may contain spaces, Unicode, and inline =; bounded to 2048 UTF-8 bytes and parser-lossless |
| patches | array | no | Ordered host-file-to-existing-logical-member replacement mappings. Omission normalizes to an empty array for translation-only requests. Host sources and logical destinations are distinct identities. | 0-256 ordered {hostSource, logicalMember} values; mapping components reject = and single/double quotes and are bounded to 2048 UTF-8 bytes |
| translations | array | no | Optional typed CSV-to-exact-logical-import-source translation mapping for a combined package patch. Omission keeps ordinary-only behavior; ordinary patches may also be empty. Combined execution stages an operation-owned BOM-stripped CSV, derives native destinations before mutation, and verifies output content through native getters. Standalone translation cardinality and map grammar are unchanged. | omitted or exactly one ordered {csv, resource} value; an explicit empty translations array is rejected; CSV and logical components reject = and single/double quotes and are bounded to 2048 UTF-8 bytes |
| locales | array | no | Optional exact locale identifiers for the admitted translation mapping. Omitted locales select only new CSV locales, never all locales. Duplicate or malformed identifiers are rejected rather than expanded or guessed. | 1-256 exact safe locale identifiers; only with a translation mapping |
| output | string | no | Optional exact output PCK file. Omission uses a unique source-named patched .pck beside the source, with the operation ID, independently of replacement/CSV locations. | literal host output file path; may contain spaces, Unicode, and inline =; bounded to 2048 UTF-8 bytes and parser-lossless |
| session | array | no | Optional ordered session controls. Only the accepted multithreading action is admitted. | ordered multithreading actions only; each emits --disable-multithreading=true\|false |
| workspace | string | no | Optional absolute internal workspace and relative host-path base. Omission uses configured workspace or automatic Temp; automatic Temp requires absolute host paths. | absolute local Windows drive path |
| timeoutMs | integer | no | Optional caller-selected cancellation budget. There is no implicit package-patch timeout. | positive safe integer milliseconds, bounded at 3600000 |

#### Declared effects

- Reads: `ordinary-only execution reads the admitted source package, resolved replacement host files, fixed native package inspector, and output package for verification; combined execution additionally reads the original and operation-owned prepared translation CSVs plus the fixed combined preparation/verification scripts`
- Writes: `the accepted effective output package and native temporary sibling, operation-local source/output inspection and adapter verification reports, profiles, logs, manifest, and artifact inventory`, `combined execution additionally writes an operation-owned BOM-stripped prepared CSV, fixed preparation/verification request and report files, and native-generated resources/config under the operation profile's .tmp_translations directory; temporary resources remain unverified loose files rather than verified package artifacts`
- Network: false
- Code execution: false
- Unknown scope: false

<details>
<summary>Evidence and coverage</summary>

- [S] [https://github.com/GDRETools/gdsdecomp/blob/e2780fcc73ab14083967d3945e513d1f6af1dbd0/standalone/gdre_main.gd#L1793-L1848](https://github.com/GDRETools/gdsdecomp/blob/e2780fcc73ab14083967d3945e513d1f6af1dbd0/standalone/gdre_main.gd#L1793-L1848) — The pinned native patch path loads the source, replaces admitted logical members, retains non-target members, and constructs the output package; mapping components cannot contain =, and source/output option values are not split as mappings.
- [R+] [docs/operation-contract.md](../docs/operation-contract.md) §8.2 — controlled native CLI replacement fixture — One native create and one patch against the fixed runtime verified an unencrypted standalone format-2/engine-4.4 package: the target payload was replaced, non-target members were retained, and source/replacement inputs were unchanged. It does not establish adapter preparation or general format support.
- [R+] [test/pck-patch-native.test.ts](../test/pck-patch-native.test.ts) and [test/pck-patch-runtime-stdio.test.ts](../test/pck-patch-runtime-stdio.test.ts) — Authored unencrypted format-2/engine-4.4.0 packages and an independent reader verify exact replacement/retained bytes, inherited headers and preserved inputs through native transactions and real-runtime production MCP/stdio. Controlled host/stdio faults separately cover contradictory reports, partial files and owned stop; no encrypted or target-game support is inferred.
- [R+] [test/pck-patch-combined-native.test.ts](../test/pck-patch-combined-native.test.ts), [test/pck-patch-combined-execution.test.ts](../test/pck-patch-combined-execution.test.ts) and [test/pck-patch-combined-runtime-stdio.test.ts](../test/pck-patch-combined-runtime-stdio.test.ts) — Authored unencrypted format-2/engine-4.4.0 fixtures verify translation-only, mixed binary replacements and permitted new locales through fixed native preparation, direct patching and output getters, including text/binary project configuration, retained newer/non-target content, unchanged inputs and operation-local profiles. Real production stdio covers repeated calls and live owned cancellation with an independent successful survivor; it does not establish mid-serialization interruption, arbitrary-format compatibility or game loading.
- [S] [src/pck-patch-operation.ts](../src/pck-patch-operation.ts) and [native/gdre-pck-inspect.gd](../native/gdre-pck-inspect.gd) — Fixed read-only payload inspections surround the direct native patch command. Host preparation protects input/output identities; complete reports, exact content comparisons and normal-success inventory establish success, while failure and stopped evidence remain distinct from verified output.
- [S] [src/schemas.ts](../src/schemas.ts) and [src/pck-patch-planning.ts](../src/pck-patch-planning.ts) — Admission rejects empty mapping families, unsupported fields, unsafe logical members, repeated raw host sources and case-folded collisions among visible admitted logical identities within or across ordinary/translation families. Native-resolved generated destinations and project-config collisions remain preparation checks. Planning requires resolved absolute source/patches/CSVs and an explicit effective output, preserving order and exact identities without filesystem certification.
- [S] [https://github.com/GDRETools/gdsdecomp/blob/e2780fcc73ab14083967d3945e513d1f6af1dbd0/standalone/gdre_main.gd#L1344-L1375](https://github.com/GDRETools/gdsdecomp/blob/e2780fcc73ab14083967d3945e513d1f6af1dbd0/standalone/gdre_main.gd#L1344-L1375) — The pinned native source patches project configuration inside the mapping loop and accumulates an import map, making repeated mappings unsafe. Admission therefore accepts exactly one mapping instead of serializing or dropping extras, and ordinary-only cardinality is unchanged. This source evidence is not product combined-execution acceptance.
- [S] [https://github.com/GDRETools/gdsdecomp/blob/e2780fcc73ab14083967d3945e513d1f6af1dbd0/exporters/translation_exporter.cpp#L2733-L2737](https://github.com/GDRETools/gdsdecomp/blob/e2780fcc73ab14083967d3945e513d1f6af1dbd0/exporters/translation_exporter.cpp#L2733-L2737) — Generated destination identities depend on native loaded/default resources and optional project configuration. Admission preserves exact explicit/new-locales-only semantics but does not derive or guess destinations; combined preparation owns that derivation and conflict rejection.

Fixture IDs: `pck-patch-route-v1`, `pck-patch-native`, `pck-patch-runtime-stdio`, `pck-patch-combined-native`, `pck-patch-combined-execution`, `pck-patch-combined-runtime-stdio`

##### Constraints

- strict input admits one literal source package, 0-256 ordered ordinary replacements and/or exactly one typed translation mapping, optional exact locales only with translations, optional literal output, ordered multithreading session, workspace, and timeoutMs; at least one mapping family is required, and globs, filters, keys, caller scripts, embedding, and unknown fields are rejected
- logical members are exact canonical res:// identities with nonempty non-dot forward-slash segments and no control, colon in the relative part, backslash, wildcard, equals, quote, edge whitespace, or parser-lossy characters
- repeated raw hostSource spellings and case-folded logicalMember collisions are rejected instead of selecting a dictionary winner
- hostSource and logicalMember mapping components reject = and any single or double quote under the documented CLI-map representability policy; source and output option values are not mapping components and keep their ordinary grammar, including inline =
- combined translation CSV and logical-resource components also reject = and quotes under the CLI mapping grammar, while standalone translation admission keeps its wider map grammar and cardinality unchanged
- combined admission accepts translation-only (normalized empty ordinary patches) and mixed requests without a dummy replacement, but rejects no mapping family, more than one translation mapping, empty translations, and locales without translations
- translation resources, ordinary logical members and exact locale identifiers reuse standalone safety and exactness; cross-family case-folded conflicts among visible admitted logical identities, malformed identities, and duplicate or invalid locales are rejected before planning; native-resolved generated and project-config destination conflicts remain preparation checks
- planning preserves admitted order and requires exactly matching resolved source/patches/translation CSVs and an explicit effective output; already-absolute admitted source, host, CSV and output spellings must agree lexically with resolved display spellings, while relative admitted values trust host workspace resolution; missing, relative, parser-lossy or contradictory resolved context fails before launch
- combined argv is --headless --no-header -- followed by ordered session actions, --pck-patch=SOURCE, --output=OUTPUT, ordered --patch-file=HOST=res://MEMBER tokens, --patch-translations=ABS_CSV=res://IMPORT when admitted, and --locales=EXACT,LIST only for explicit locales
- resolvedPckTranslations carries original host-resolved CSV provenance and absolute-identity comparison; optional preparedPckTranslations carries the distinct operation-owned BOM-stripped copy used for CLI argv and read effects, and neither is a generated translation destination; pure planning does not certify prepared-copy ownership, so combined execution must supply prepared copies rather than host originals; omitted locales preserve new-locales-only semantics with no all-locales expansion or guessed keys
- combined execution validates CSV UTF-8/content/locales, fingerprints the original and operation-owned BOM-stripped prepared copies, rejects CSV/source/ordinary/output/admin aliases, and launches one fixed read-only preparation script that derives actual native import/default-locale/generated destinations and optional text/binary project registration before any mutation; an unrepresentable, conflicted or unreadable identity fails closed without a patch launch
- ordinary-only host preparation verifies standalone unencrypted PCK type and exact existing targets, fingerprints replacement files, rejects resolved aliases/hardlinks and unsafe/existing output or tmp collisions, supplies a unique source-adjacent patched PCK when omitted, and revalidates identities before mutation
- planning alone does not establish file existence, package type, encryption, existing-member identity, canonical host aliases, output absence, or source/output/CSV collisions; those are host preparation checks
- ordinary success requires natural exit zero and exact patch marker without patch-error evidence, complete fixed source/output inspection, exact replacement/retained hashes and inherited metadata, unchanged inputs and accepted normal-success inventory; combined success additionally requires the permitted member-set/byte gate, unchanged source/replacement/original CSV/prepared CSV identities, and accepted independent native getter verification of every selected and retained locale plus project configuration presence or registration; reports remain operation-local and the verified PCK has output-package artifact role
- known failure, cancellation and deadline preserve acquired reports/streams and bounded available unverified-file observations without exhaustive post-stop audit; there is no implicit patch timeout or cross-call target reservation

##### Prerequisites

- the fixed local Windows GDRE runtime and the pinned native route source
- the fixed read-only native/gdre-pck-inspect.gd inspector and safe distinct output; controlled format-2/engine-4.4.0 fixture evidence does not establish arbitrary-format compatibility, encrypted patching, importing or game loading
- combined admission consumes the frozen combined CLI contract and pinned native source; combined execution uses the fixed read-only preparation/verification scripts and operation-local prepared CSV staging, and controlled runtime evidence does not establish arbitrary-format, encrypted, importing or game-loading behavior

</details>
