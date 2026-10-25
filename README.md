# Godot GDRE MCP

A Windows x64 stdio MCP server for [Godot RE Tools (GDRE)](https://github.com/GDRETools/gdsdecomp).

**Work in progress.** This adapter exposes the six tools below, not the full GDRE feature set. Interfaces and behavior may change. GDRE is obtained separately; this repository builds the adapter, not GDRE itself.

## Supported tools

| Tool | Purpose |
| --- | --- |
| `gdre_version` | Query the installed GDRE version and report diagnostics. |
| `gdre_list_files` | List supported package/project members using literal inputs or filesystem globs. |
| `gdre_extract` | Extract all members, selected patterns, scripts, or translation resources. |
| `gdre_export_resources` | Export selected resources into editable forms using GDRE's native exporters. |
| `gdre_patch_translations` | Write edited CSV text into standalone translation resources for existing or new locales. |
| `gdre_pck_patch` | Write a separate unencrypted PCK with existing-member replacements and/or one translation mapping. |

These are supported subsets, not promises of every upstream format or option. See [tool usage](docs/tool-usage.md) for examples and limitations, and the [generated reference](docs/command-reference.md) for parameters.

## Requirements

- **Windows 10/11 x64.** Linux and macOS are not supported.
- **Node.js 24.x** with npm. Node 22 is not supported.
- A separately provisioned **Windows x64 GDRE runtime**. The recorded test baseline is `2.8.0-beta.2`; other versions are not automatically rejected, but compatibility is not guaranteed.
- System **Windows PowerShell 5.1** for the process helper. PowerShell 7 is not a replacement for this dependency. No separate .NET SDK, Visual Studio, or Godot editor is required to build the adapter/helper.
- Writable temporary storage, and a writable `native/` directory when the helper needs compilation.

## Setup

### 1. Build the adapter

From the repository root:

```sh
npm ci
npm run build
```

Keep the checked-in `native/` directory alongside the generated `dist/`. On startup, the server prepares its Windows process helper automatically; preparation failure prevents startup. See [runtime provisioning](docs/runtime-provisioning.md) for manual preparation and troubleshooting.

### 2. Supply GDRE

Obtain the Windows runtime from [GDRE releases](https://github.com/GDRETools/gdsdecomp/releases), or build it using upstream instructions. Keep these files together with their exact names:

```text
vendor/GDRE_tools/
  gdre_tools.exe
  gdre_tools.pck
  GodotMonoDecompNativeAOT.dll
```

Preserve upstream companion files and notices. To use another directory, set `GDRE_MCP_RUNTIME_DIR` to its absolute path. There is no automatic runtime download or update.

### 3. Connect your MCP client

Register a stdio server, replacing the example installation path with your own:

```json
{
  "mcpServers": {
    "godot-gdre": {
      "command": "node",
      "args": ["D:/Tools/godot-gdre-mcp/dist/src/index.js"]
    }
  }
}
```

Use an absolute `node.exe` path if the client cannot resolve `node`. Configuration locations vary by client; keep the command and arguments separate rather than combining them into a shell string.

No adapter config file or environment variables are required. Common optional overrides are:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GDRE_MCP_RUNTIME_DIR` | `<installation>/vendor/GDRE_tools/` | Select an absolute GDRE runtime directory. |
| `GDRE_MCP_WORKSPACE` | `<system temp>/GodotGdreMcp/` | Select an absolute internal-state directory and enable workspace-relative host paths. |

Use **absolute host file paths** unless you explicitly select a workspace in the call, environment, or config. Logical `res://` member names are not host paths. See [advanced configuration](docs/runtime-provisioning.md#configuration) for config files and precedence rules.

### 4. Make a first call

Ask your client to list tools, then call `gdre_version` with `{}`. All six tools should be discoverable. Check the call's success and diagnostics: discovery alone does not establish that GDRE is usable.

## Outputs and retained records

Product-producing calls create a unique output beside the admitted input unless you supply `output`; they do not overwrite originals. Directory inputs get sibling directories, not children. Inputs from different parents require explicit output. The response's `paths.effectiveDestination` identifies the product. See [output rules](docs/tool-usage.md#shared-path-and-output-rules) for names and destination requirements.

Internal logs, records, profiles, and intermediate files default to `<system temp>/GodotGdreMcp/.gdre/`. They may contain sensitive paths or content. The adapter does not automatically delete them, but OS Temp cleanup may; select a persistent workspace if retention matters. Do not put that workspace inside a source directory you intend to scan recursively. A workspace is **not a filesystem sandbox**.

## Development

After provisioning GDRE, run `npm run check` to typecheck, test, and verify the generated reference. `npm start` runs the built stdio server; stdout is reserved for MCP traffic.

See [development](docs/development.md) for individual commands, repository layout, and contributor documentation.

## License

This project's code is licensed under the [MIT License](LICENSE), the same license used by [GDRE's main project](https://github.com/GDRETools/gdsdecomp/blob/master/LICENSE).

GDRE is separate and is not bundled here. Its runtime and third-party components retain their own copyrights, licenses, and distribution requirements. The same applies to other dependencies.

## Acknowledgments

- [Godot RE Tools (GDRE)](https://github.com/GDRETools/gdsdecomp), its original author bruvzg, and its contributors, for the recovery, export, and patching functionality this adapter exposes.
- [Godot Engine](https://github.com/godotengine/godot) and its contributors, for the engine and resource ecosystem underlying GDRE.
