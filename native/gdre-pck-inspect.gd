extends SceneTree

# Adapter-owned fixed read-only PCK inspector for gdre_pck_patch.
#
# Launch:
#   --headless --script <this file> -- <report.json> <absolute-package>
#
# It loads exactly one standalone unencrypted PCK through the fixed runtime,
# enumerates the loaded logical members, and reads every payload through the
# native FileAccess layer to report the actual byte size and SHA-256. It performs
# no recovery, extraction, mutation, filter selection or post-failure audit.
#
# GDScript asserts are disabled in the fixed release build, so every native
# return value below is checked explicitly.

const SCHEMA_VERSION := 1
const PACK_TYPE_PCK := 0
const MAX_SAFE_INTEGER := 9007199254740991
const READ_CHUNK := 65536

var _report_path := ""
var _package_path := ""
var _report: Dictionary = {}
var _loaded := false


func _initialize() -> void:
	var args: PackedStringArray = OS.get_cmdline_user_args()
	if args.size() != 2:
		push_error("gdre-pck-inspect requires exactly a report path and one package path")
		quit(2)
		return
	_report_path = String(args[0])
	_package_path = String(args[1])
	if not _is_absolute_local(_report_path) or not _is_absolute_local(_package_path):
		push_error("gdre-pck-inspect requires absolute report and package paths")
		quit(2)
		return
	if _same_path(_report_path, _package_path):
		push_error("gdre-pck-inspect report path must differ from the package path")
		quit(2)
		return

	_report = {
		"schemaVersion": SCHEMA_VERSION,
		"ok": false,
		"packagePath": _normalize_path(_package_path),
		"error": null,
	}

	var load_code: int = GDRESettings.load_project(PackedStringArray([_package_path]), true)
	if load_code != OK:
		_fail("native load_project failed")
		return
	_loaded = true

	var pack_infos = GDRESettings.get_pack_info_list()
	if pack_infos.size() != 1:
		_fail("native package load did not yield exactly one package")
		return
	var info = pack_infos[0]
	if info == null:
		_fail("native package metadata is unavailable")
		return
	if int(info.get_type()) != PACK_TYPE_PCK:
		_fail("input is not a standalone PCK")
		return
	if bool(info.is_encrypted()):
		_fail("encrypted packages are not supported")
		return
	var version = info.get_version()
	if version == null:
		_fail("native package engine version is unavailable")
		return
	var format_version := int(info.get_fmt_version())
	if format_version < 0:
		_fail("native package format version is invalid")
		return
	var engine_major := int(version.get_major())
	var engine_minor := int(version.get_minor())
	var engine_patch := int(version.get_patch())
	if engine_major < 0 or engine_minor < 0 or engine_patch < 0:
		_fail("native package engine version is invalid")
		return

	var files: Array = []
	for file in GDRESettings.get_file_list():
		files.append(String(file))
	if files.size() != int(info.get_file_count()):
		# GDREPackedData stores listed paths in a map keyed by path identity, so a
		# raw package with hidden duplicate/aliased entries can list fewer names
		# than its declared directory count. Do not normalize that into success.
		_fail("native member listing does not match the package file count")
		return

	# PackedFileInfo retains the raw header spelling and marks every fix_path
	# replacement as malformed. Validate that metadata before reading payloads so
	# a native-normalized name cannot be accepted as the original identity.
	var file_infos = GDRESettings.get_file_info_array()
	if file_infos.size() != files.size():
		_fail("native file-info metadata does not match the member listing")
		return
	var info_by_path := {}
	for file_info in file_infos:
		if file_info == null:
			_fail("native file-info metadata is unavailable")
			return
		var listed_path := String(file_info.get_path())
		if info_by_path.has(listed_path):
			_fail("native file-info metadata repeats a listed path")
			return
		info_by_path[listed_path] = file_info

	var members: Array = []
	var seen := {}
	var seen_folded := {}
	for file in files:
		var listed_value := String(file)
		if not info_by_path.has(listed_value):
			_fail("native file-info metadata does not cover the member listing")
			return
		var file_info = info_by_path[listed_value]
		if bool(file_info.is_malformed()):
			_fail("native package contains a malformed logical member identity")
			return
		if bool(file_info.is_encrypted()):
			_fail("native package contains an encrypted member")
			return
		var raw_logical := _canonical_logical(String(file_info.get_raw_path()))
		var listed_logical := _canonical_logical(listed_value)
		if raw_logical == "" or listed_logical == "" or raw_logical != listed_logical:
			_fail("native file-info identity does not match the listed logical member")
			return
		var logical := raw_logical
		if seen.has(logical):
			_fail("native package contains a duplicate logical member")
			return
		var folded := logical.to_lower()
		if seen_folded.has(folded):
			_fail("native package contains an ambiguous case-folded logical member")
			return
		seen[logical] = true
		seen_folded[folded] = true

		var payload := _read_payload(logical, int(file_info.get_size()))
		if not bool(payload.get("ok", false)):
			_fail(String(payload.get("error", "member payload could not be read")))
			return
		members.append({
			"logicalMember": logical,
			"size": int(payload["size"]),
			"sha256": String(payload["sha256"]),
		})

	_report["metadata"] = {
		"formatVersion": format_version,
		"engineVersion": {
			"major": engine_major,
			"minor": engine_minor,
			"patch": engine_patch,
		},
		"encrypted": false,
	}
	_report["members"] = members
	_report["ok"] = true
	_report["error"] = null
	_unload()
	_write_report(0)


# --- member names and payloads ---------------------------------------------

func _canonical_logical(raw: String) -> String:
	if raw == "" or raw.contains("\\"):
		return ""
	if raw.begins_with("res://"):
		return raw if _is_inventory_member(raw) else ""
	if raw.begins_with("/") or raw.contains("://"):
		return ""
	var logical := "res://" + raw
	return logical if _is_inventory_member(logical) else ""


func _is_inventory_member(value: String) -> bool:
	# Retained source inventory is not a CLI mapping component: "=", single
	# quotes, edge spaces and trailing-dot segments are valid raw identities as
	# long as PackedFileInfo did not rewrite the path. Mapping-representability
	# restrictions belong to the host typed planner. Only traversal/ambiguous
	# structure and control characters are rejected here.
	if not value.begins_with("res://"):
		return false
	var relative := value.substr(6)
	if relative == "" or relative.begins_with("/") or relative.ends_with("/"):
		return false
	var segments := relative.split("/")
	for segment in segments:
		if segment == "" or segment == "." or segment == "..":
			return false
		for index in range(segment.length()):
			var code := segment.unicode_at(index)
			if code < 32 or code == 127:
				return false
	return true


func _read_payload(logical: String, expected_size: int) -> Dictionary:
	if expected_size < 0 or expected_size > MAX_SAFE_INTEGER:
		return {"ok": false, "error": "member size is not a safe nonnegative integer: " + logical}
	var file := FileAccess.open(logical, FileAccess.READ)
	if file == null:
		return {"ok": false, "error": "member payload could not be opened: " + logical}
	var length := file.get_length()
	if length != expected_size:
		file.close()
		return {"ok": false, "error": "member size disagrees with native file-info metadata: " + logical}
	var context := HashingContext.new()
	if context.start(HashingContext.HASH_SHA256) != OK:
		file.close()
		return {"ok": false, "error": "sha256 context could not start: " + logical}
	var remaining := length
	while remaining > 0:
		var chunk := file.get_buffer(min(READ_CHUNK, remaining))
		if chunk.is_empty():
			file.close()
			return {"ok": false, "error": "member payload read was short: " + logical}
		if chunk.size() > remaining:
			file.close()
			return {"ok": false, "error": "member payload read exceeded its declared size: " + logical}
		if context.update(chunk) != OK:
			file.close()
			return {"ok": false, "error": "sha256 update failed: " + logical}
		remaining -= chunk.size()
	var digest := context.finish().hex_encode()
	file.close()
	return {"ok": true, "size": length, "sha256": digest}


# --- report and path helpers ------------------------------------------------

func _fail(message: String) -> void:
	_report["ok"] = false
	_report["error"] = message
	_unload()
	_write_report(1)


func _unload() -> void:
	if _loaded:
		GDRESettings.unload_project()
		_loaded = false


func _write_report(exit_code: int) -> void:
	# Report-open failure is covered by the acceptance test. A post-open write
	# failure is not portably inducible on Windows without a fault-injecting
	# filesystem, so both the store result and flush/get_error are checked
	# explicitly rather than trusting close(). Any failure exits nonzero.
	var file := FileAccess.open(_report_path, FileAccess.WRITE)
	if file == null:
		push_error("gdre-pck-inspect could not open the report path")
		quit(3)
		return
	var stored := file.store_string(JSON.stringify(_report))
	file.flush()
	var write_error := file.get_error()
	file.close()
	if not stored or write_error != OK:
		push_error("gdre-pck-inspect could not write the report path")
		quit(3)
		return
	quit(exit_code)


func _is_absolute_local(value: String) -> bool:
	# The fixed runtime is Windows: only a letter drive followed by ":/" or ":\"
	# is a supported local absolute path. Validate the raw spelling before any
	# normalization so UNC/device/rooted drive-less and non-letter-drive forms
	# cannot be hidden into an accepted path.
	if value.length() < 3:
		return false
	var drive := value.unicode_at(0)
	if not ((drive >= 65 and drive <= 90) or (drive >= 97 and drive <= 122)):
		return false
	if value.unicode_at(1) != 58:
		return false
	var separator := value.unicode_at(2)
	return separator == 47 or separator == 92


func _normalize_path(value: String) -> String:
	var normalized := value.replace("\\", "/")
	normalized = normalized.simplify_path()
	return normalized


func _same_path(first: String, second: String) -> bool:
	return _normalize_path(first).to_lower() == _normalize_path(second).to_lower()
