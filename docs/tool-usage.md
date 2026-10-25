# Tool usage and execution limits

See the [README](../README.md) for setup and the [generated reference](command-reference.md) for complete parameters. Calls below are tool argument objects, not shell commands.

## Shared path and output rules

Workspace configuration is optional. Without an explicitly selected call/environment/config workspace, use **absolute host paths**; internal state defaults to `<system temp>/GodotGdreMcp/.gdre/`. Each example selects `D:/GDRE Work`, so its relative host paths resolve there, never against the client's working directory. Replace that path and the sample files with your own. Logical `res://` members and selection patterns are not host paths.

When `output` is omitted, products are created beside the admitted primary input:

| Operation on `D:/Games/demo.pck` | Default product |
| --- | --- |
| Extract | `D:/Games/demo-extracted-<operationId>/` |
| Export resources | `D:/Games/demo-exported-<operationId>/` |
| Standalone translations | `D:/Games/demo-translations-<operationId>/` |
| Patch PCK, ordinary or combined | `D:/Games/demo-patched-<operationId>.pck` |

- Directory inputs get siblings, not children, and retain their full directory name.
- Same-parent multi-inputs use `gdre-<operation-kind>-<operationId>/`; different parents require explicit output. CSVs, hints, replacements, and loader dependencies do not select the parent.
- Explicit output is honored at its resolved location, including outside the workspace. Directory destinations must be absent or empty; PCK destinations must not exist and their parent must already exist. There is no overwrite/in-place mode or fallback to Temp after a destination error.
- `paths.effectiveDestination` identifies the product. `paths.output` is separate internal storage and may remain empty. Version/list calls produce no user product.
- Native extraction/export logs and reports may accompany products; PCK patching may leave an adjacent `.tmp`. Neither outputs nor records are automatically deleted. OS cleanup can remove Temp records.

## Listing a controlled input

Use `gdre_list_files` to inspect members before selecting extraction or export:

```json
{
  "workspace": "D:/GDRE Work",
  "inputs": [{ "kind": "path", "path": "packs/example.pck" }],
  "session": [{ "kind": "multithreading", "disabled": false }]
}
```

`inputs` accepts literal paths or `{ "kind": "glob", "pattern": "packs/**/*.pck" }`. Supported filesystem glob forms are `*`, `?`, and `**`; there is no shell expansion. An optional `key` is a supplied 64-hex package key, not key discovery.

The accepted input subset includes controlled PCK formats 0–4, stored ZIP, minimal assets-only APK, XAPK, marked local directories, controlled single-pack `.app` layouts, and executable sidecars. Listing has one encrypted fixture; this does not establish encrypted support for other tools. Embedded executables, IPA, valid empty packs, ambiguous bundle layouts, and overlay precedence are not supported claims. A directory must be the sole input and must not recursively contain workspace `.gdre` metadata. These directory guards also apply to extraction/export.

Results include `totalFiles`, at most 32 member samples, `truncated`, and the complete retained listing evidence path. Members are not filesystem artifacts. Load errors, wrong keys, incomplete streams, or ambiguous empty listings do not become success merely because GDRE exits zero.

## Extracting a controlled input

Use `gdre_extract` for raw members, not editable-resource recovery:

```json
{
  "workspace": "D:/GDRE Work",
  "inputs": [{ "kind": "path", "path": "packs/example.pck" }],
  "output": "exports/example",
  "selection": "scripts"
}
```

`selection` is `all` (default), `scripts` (`.gd`, `.gdc`, `.gde`), or `translations` (`.translation`, `.xl`). Extension matching for these modes is case-insensitive. Non-`all` modes cannot combine with nonempty filters. For custom selection instead use, for example:

```json
{
  "workspace": "D:/GDRE Work",
  "inputs": [{ "kind": "path", "path": "packs/example.pck" }],
  "include": ["res://**/*.gd"],
  "exclude": ["res://addons/*"]
}
```

Member patterns differ from filesystem input globs:

- Patterns are ordered and case-sensitive; dot-prefixed members are included.
- Includes use segment matching: `*`/`?` stay within a segment; `**/` also matches zero directories.
- Excludes use anchored native matching: `*` crosses `/`; `**/` requires a slash.
- Backslashes and bare `*.ext` forms are normalized. Consequently `include:["*.gd"]` selects root and nested scripts, but `exclude:["*.gd"]` removes only nested scripts. Use `exclude:["res://*.gd"]` to remove both.
- Directory-source filters accept only bare-star forms without a slash or `**`, such as `*.gdc`. Other forms are rejected because native real/logical path matching is inconsistent.
- No-match fails before extraction. Empty script/translation groups never fall back to extracting everything.

The default checksum policy stays enabled; extraction does not accept supplied keys or checksum overrides. PCK checksums cover the full loaded member set, so an excluded member's invalid MD5 still fails. `semantic.data` separates `totalFiles`, `selectedFiles`, `extractedFiles`, and `checksumCoverage`; corroborated non-PCK sources may have `scope:"not-applicable"` with nullable checksum counts.

Success requires exact selected output and complete evidence. `gdre_export.log` is administrative, not an extracted member. Extraction does not execute recovered files or establish that a project is deployable.

## Exporting selected editable resources

Use `gdre_export_resources` for GDRE's native filtered exporters, not raw extraction or full project recovery:

```json
{
  "workspace": "D:/GDRE Work",
  "inputs": [{ "kind": "path", "path": "packs/example.pck" }],
  "selection": {
    "kind": "members",
    "include": ["res://.godot/imported/*.translation", "res://main.gdc"]
  },
  "output": "exports/editable"
}
```

Select actual package members, usually imported destination resources rather than absent source files or `.import` metadata. Alternatively use `"selection":{"kind":"group","group":"translations"}` or `"group":"scripts"`. Selection is required; there is no default/all or excludes-only mode, and no-match fails before recovery. Resource types are not restricted to an image/audio/translation whitelist.

Project-directory inputs support groups; member patterns are restricted to bare-star forms such as `*.translation`. Package member patterns follow the extraction rules above. Optional controls include:

- `translationHints`: protected literal host files, relative to the selected workspace when not absolute.
- `collectResourceStrings`: defaults to true. False skips native collection but retains supplied hints.
- `dumpResourceStrings`: defaults to false. A dump is conditional on native key recovery and is not promised for every translation; with collection disabled it may contain hints only.

Supplied keys and checksum overrides are rejected. `semantic.data.completeness` distinguishes `complete`, `partial`, `unsupported`, `failed`, and `unknown`; only `complete` succeeds. Several selected locale members may produce one CSV, so member/export counts can differ. Use `reports.native`, `reports.nativeLog`, `reports.adapter`, and the full inventory to distinguish verified editable resources from raw files and scaffolding. Generated project/import metadata does not establish complete recovery, inverse importing, or target-game compatibility.

## Writing standalone translations

`gdre_patch_translations` writes edited CSV text into standalone translation resources, not a patched PCK:

```json
{
  "workspace": "D:/GDRE Work",
  "inputs": [{ "kind": "path", "path": "packs/example.pck" }],
  "translations": [{ "csv": "edits/translations.csv", "resource": "res://translations.csv" }],
  "locales": ["zh"],
  "output": "exports/patched-translations"
}
```

`csv` is an edited host file. `resource` is the exact, case-sensitive logical **import source**, not a host file or an imported `.translation` destination. Inputs must be literal paths, not globs.

- Explicit locales select exact CSV column names using native canonical spelling. **Omitting locales selects only new locale columns**, not all existing languages; no applicable new locale is a failure.
- Original resources must be compatible optimized translations with unambiguous CSV import metadata. Ordinary nonoptimized `Translation` resources are not supported.
- Unknown keys, unresolved missing-key placeholders, and unconfirmable empty original lookups are rejected. Clearing a confirmed nonempty original value is supported; this tool does not recover keys or add genuinely new keys.
- CSVs require valid UTF-8, exactly one `key` column, unique nonempty keys and locale columns, consistent widths, and valid quoting. LF/CRLF are accepted; native CRLF-in-field normalization to LF is recorded. Only an initial BOM is removed in an operation-owned copy; originals remain unchanged.
- Duplicate/aliased CSVs, conflicting targets, unsafe paths, and output collisions are rejected. Existing locales keep their logical paths; new locales use native-derived paths. Native project configuration may accompany the resources. Only selected/generated locales are emitted.

An optional `key` accepts a supplied 64-hex package key. Success requires native read-back of requested and retained text, resource/locale properties, and complete normal-success inventory. Failed writes may leave files: `counts.unverifiedFiles` and `samples.unverifiedFiles` distinguish native-reported files from verified outputs. Same-runtime read-back does not prove target-game compatibility.

## Patching existing package members

`gdre_pck_patch` replaces members in one standalone unencrypted PCK and writes a separate output PCK:

```json
{
  "workspace": "D:/GDRE Work",
  "source": "packs/example.pck",
  "patches": [{ "hostSource": "edits/replace.bin", "logicalMember": "res://data/replace.bin" }],
  "output": "exports/patched.pck"
}
```

`source` and `hostSource` are host files; `logicalMember` is an exact existing `res://` member. Ordinary-only requests require 1–256 ordered replacements. New ordinary members, duplicate/aliased sources, and case-folded target collisions are rejected. Map components cannot contain `=` or single/double quotes because of the native CLI grammar. Logical paths cannot contain traversal, empty/dot segments, or wildcards.

`output` is a **file**. Existing output or occupied adjacent `.tmp` paths fail; there is no in-place patching. Success requires exact replacement bytes, unchanged retained members and protected inputs, inherited metadata, complete inspection reports/inventory, and natural exit zero with the expected marker and no patch errors. Output existence alone is insufficient. Controlled format-2/engine-4.4.0 fixtures establish this behavior, not arbitrary-format compatibility.

### Combined translation and package patching

The same tool accepts **one** translation mapping, alone or alongside ordinary replacements:

```json
{
  "workspace": "D:/GDRE Work",
  "source": "packs/example.pck",
  "translations": [{ "csv": "edits/translations.csv", "resource": "res://i18n/translations.csv" }],
  "locales": ["zh"],
  "output": "exports/translated.pck"
}
```

For translation-only requests, omit `patches` or use `[]`. At least one mapping family is required; an explicitly empty `translations` array, multiple translation mappings, or locales without translations are invalid. CSV/import-source and exact/new-locale selection rules match standalone patching. Combined mapping components additionally reject `=` and quotes under the CLI-map grammar.

Read-only native preparation checks actual resource/default-locale/generated-destination identities and project configuration before mutation. Generated destinations cannot collide with ordinary targets or project config. Text and binary config are supported, with binary taking precedence; absent config is verified absent, not invented.

One native patch invocation applies the mapping families. Verification checks ordinary bytes and untouched members, plus native getters for generated translation class/locale/path, requested and retained text, and config registration or absence. Regenerated translation/config bytes can differ, so getters replace byte-retention checks for those members. Protected original and BOM-stripped prepared CSVs must remain unchanged.

Generated `.tmp_translations` files remain in the operation-local profile after success, failure, or stop; immediate deletion is not promised. A known failure with acquired output/temp observations is `partial`, otherwise `failed`; a stopped assessment is `unknown`. None means success. Keys, filters, embedding, caller scripts, multi-mapping execution, arbitrary-format/encrypted patching, and game-loading acceptance are not provided.

## Overlapping calls and caller coordination

Calls may overlap in the same or different workspaces. Each has independent records, profile, progress, and cancellation. Cancelling one call does not cancel another; disconnect cancels all active calls. Unconfirmed native cleanup blocks subsequent launches in that server, not already active operations.

**Coordinate conflicting file use yourself**, within one server and across sessions: do not write paths another call is reading or writing. Invocation-local input/output, alias, metadata, and destination checks remain, but there are no shared-target reservations, cross-process locks, or guarantees against external programs or hostile filesystem races.

## Timeouts, progress, and retained records

- Tools have **no implicit operation timeout**. Call `timeoutMs` overrides `defaults.<command>.timeoutMs`; either is bounded by `timeouts.maxMs` (default ceiling 3600000).
- The timer starts before the first owned process attempt, covers native preflight/work and required output checks, and stops before terminal publication. It is not a preparation SLA or disk-write deadline. Platform startup/stop limits are separate.
- Progress reports phase transitions, not heartbeats or completion percentages. Configure the host's request timeout separately.
- `manifest.json` is one terminal record (`recordVersion:2`, result `schemaVersion:1`), not a live status feed. Startup does not resume or repair old records. Forced server loss can leave files without a manifest; requests rejected before allocation have none.
- Responses contain bounded samples and references to full records. Raw logs may contain sensitive content; known supplied keys are redacted in normal results/manifests, not guaranteed absent from raw native logs.
- Failure/cancellation preserves partial files and acquired diagnostics without beginning an exhaustive post-stop audit. `artifacts.complete:false` with `count:0` does **not** establish an empty destination. Read retained logs when semantic evaluation is `not_evaluated`.

## Scope and safety

Only the six registered tools and their documented subsets are implemented. There is no complete-project recovery, arbitrary argv/caller scripts, HTTP transport, automatic runtime update, or implicit recovered-code execution. Runtime version/hash differences warn; missing or unusable runtime material yields operation failures while tools remain discoverable.

Profiles and the Windows Job Object helper isolate operation state and own native process cleanup; they are **not a security sandbox** or supervision of processes outside the Job. Missing final records do not prove successful cleanup.

For setup see [runtime provisioning](runtime-provisioning.md). Contributors can find implementation constraints and acceptance tests through [development](development.md).
