# GDRE runtime provisioning

GDRE is an external dependency. Obtain the Windows x64 runtime from the [GDRETools/gdsdecomp repository](https://github.com/GDRETools/gdsdecomp) or its [official releases](https://github.com/GDRETools/gdsdecomp/releases). Consult upstream for GDRE build instructions and toolchain requirements. This MCP repository does not build, download, redistribute, or automatically update GDRE.

## Required layout

Place these files together under `vendor/GDRE_tools/`, or set `GDRE_MCP_RUNTIME_DIR` to another absolute directory:

```text
vendor/GDRE_tools/gdre_tools.exe
vendor/GDRE_tools/gdre_tools.pck
vendor/GDRE_tools/GodotMonoDecompNativeAOT.dll
```

Keep the original companion files and applicable upstream notices. The adapter currently requires all three exact filenames; an upstream artifact with a different layout is not automatically supported. `runtimeDirectory` in an adapter config is another option; relative runtime directories resolve against the MCP installation, not the client's working directory.

## Recorded baseline and health checks

The recorded runtime baseline is GDRE CLI `v2.8.0-beta.2` with the hashes below. These identify the tested binaries, not a guarantee that every upstream download is byte-identical or that a version label proves source correspondence. Runtime health records report the CLI version and file hashes; they do not record PE or embedded-engine versions.

| File | Recorded SHA-256 |
| --- | --- |
| `gdre_tools.exe` | `598c75267729aca4b7aa7bcc06ddd428dbe76760cbed0d0fdcdb02a089d7983d` |
| `gdre_tools.pck` | `188f88b0e9bf581c445a2ac2280ed09d8987ff28311c971609e7c5cc6f3b5992` |
| `GodotMonoDecompNativeAOT.dll` | `9e23279a04ba98032398ec83454e4b9402393ea8a77d425ed4ef691ace8cd5a9` |

For a local file comparison in Git Bash:

```sh
sha256sum vendor/GDRE_tools/gdre_tools.exe \
  vendor/GDRE_tools/gdre_tools.pck \
  vendor/GDRE_tools/GodotMonoDecompNativeAOT.dll
```

The server checks companion existence/readability and hashes, then performs a `--headless --gdre-version` probe with a local 10000 ms limit at startup. Missing/unreadable companions or an unusable probe leave tools discoverable but make calls return a runtime failure. A differing hash or version produces a warning, not an automatic rejection or schema change. A successful version probe does not verify every native API needed by resource export or translation/package patching. Use the supported operations and tests for the behavior you need; no broad upstream-version compatibility claim is made.

The startup probe limit is separate from public tools, which have no implicit operation timeout.

## Windows process helper

The adapter supports Node 24 on Windows x64 and uses Windows 10+ creation-time Job Object ownership. Node and the MCP SDK do not provide this native-child cleanup by themselves.

Keep the checked-in `native/` files alongside `dist/`. Startup invokes system **Windows PowerShell 5.1** to prepare `native/gdre-job-object.dll`, compiling `native/gdre-job-object.cs` with `Add-Type` and the system .NET Framework compiler when the DLL is missing or older than the source. **No separate .NET SDK, `dotnet` CLI, NuGet restore, or Godot editor is needed for this helper.** PowerShell 7 is not a replacement. The generated DLL is ignored by Git.

To prepare it manually from the repository root in Git Bash:

```sh
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
  -File native/prepare-gdre-job-object.ps1 \
  -OutputPath native/gdre-job-object.dll
```

The installation's `native/` directory must be writable when compilation is needed. Compilation failure prevents startup. A compiler timeout requests termination through the held child-process handle and checks for exit before reporting failure.

### Optional prebuilt helper in a Release archive

A Release archive may include the adapter's own matching `native/gdre-job-object.dll`. This is not GDRE's `GodotMonoDecompNativeAOT.dll`, and supplying one does not replace the other.

Current preparation skips compilation when the DLL exists and its modification time is at least as new as the C# source; the launch wrapper uses the same timestamp condition before loading it. There is no helper content-hash validation. Package matching files together and preserve that timestamp ordering. If source becomes newer, compilation is attempted again. A damaged or incompatible DLL can fail to load rather than trigger an automatic rebuild. To rebuild a known bad local helper, remove only `native/gdre-job-object.dll` and rerun preparation in a writable checkout.

Keep the C# source and both PowerShell scripts even when shipping the DLL. Windows PowerShell is still used for preparation and launches. Prebuilt helper distribution is an optional packaging approach, not an implemented release pipeline or a read-only-install guarantee.

### Ownership and cleanup

For each launch, the PowerShell wrapper parses typed launch data from a private Node-to-helper pipe without evaluating it as shell code or persisting launch arguments. The C# helper creates GDRE inside its Job with explicit argv, working directory and environment, NUL stdin, and forwarded stdout/stderr. GDRE does not inherit the control pipe or Job handle. The control reader terminates the Job on stop or EOF; killing the helper closes its kill-on-close Job handle. The helper exits with the operation.

Process creation/Job setup failure fails the operation rather than falling back to an unowned launch. Cleanup requires native confirmation; missing evidence is not confirmation. Forced termination may prevent final records. Do not use saved PIDs or process names to clean up a later session. This is not a sandbox or supervision of host-owned work or processes outside the Job.

## Configuration

No adapter JSON file is required. To configure one, copy [`gdre-mcp.config.example.json`](../gdre-mcp.config.example.json) to `gdre-mcp.config.json` in the installation root. `GDRE_MCP_CONFIG` can select another absolute config path. The server does not load `.env` files or use the client's working directory as a path base.

| Setting | Default / resolution | Override |
| --- | --- | --- |
| `workspaceRoot` | `<system temp>/GodotGdreMcp/`; a relative configured value resolves against the config file's directory. | Absolute `GDRE_MCP_WORKSPACE`, then a call's absolute `workspace`. |
| `runtimeDirectory` | `vendor/GDRE_tools`, relative to the installation root even when the config file is elsewhere. | Absolute `GDRE_MCP_RUNTIME_DIR`. |
| `targetVersion` | `2.8.0-beta.2`; comparison target, not a compatibility guarantee. | Config only. |
| `timeouts.maxMs` | `3600000`; ceiling for opt-in tool timeouts, not an automatic deadline. | Config only, up to that ceiling. |
| `defaults.<command>` | No operation timeout or session actions by default. | Configured `timeoutMs` and, for non-version commands, ordered `session`; explicit call values replace them. |

Command keys are `version`, `list-files`, `extract`, `export-resources`, `patch-translations`, and `pck-patch`. Arrays replace configured arrays rather than concatenate; `session:[]` clears configured actions. Nonempty generic `settings` are not currently supported. `timeouts.defaultMs` and `timeouts.queueMs` are retired and rejected.

Invalid explicit overrides are errors, not silent fallback. Relative host inputs, globs, CSVs, hints, replacements, and outputs require an explicitly selected workspace; the automatic Temp workspace does not enable them. Absolute host paths can be outside that workspace. Logical `res://` identities and selection patterns are not host paths.

## Distribution boundaries

Linking users to upstream does not make upstream binaries part of this repository's distribution. If you separately redistribute GDRE or its companion DLLs, retain the notices and satisfy the licenses applicable to those exact artifacts. This project does not certify that its recorded baseline corresponds to a particular public source revision. Keep vendor payloads, upstream source checkouts, and toolchains out of Git.
