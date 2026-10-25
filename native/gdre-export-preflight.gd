extends SceneTree

# Adapter-owned fixed inspector for gdre_export_resources.
#
# Launch:
#   --headless --script <this file> -- <evidence.json> <input> [<input> ...]
#
# It loads the adapter-prepared inputs and emits native logical member and
# import metadata only. It performs no recovery, filter selection or resource
# conversion, and it accepts no caller-controlled script or settings.

func _initialize() -> void:
	var args: PackedStringArray = OS.get_cmdline_user_args()
	if args.size() < 2:
		push_error("gdre-export-preflight requires an evidence path and at least one input")
		quit(2)
		return

	var evidence_path: String = args[0]
	var inputs: PackedStringArray = args.slice(1)
	var input_list: Array = []
	for input in inputs:
		input_list.append(String(input))

	var load_result: int = GDRESettings.load_project(inputs, false)
	if load_result != OK:
		_write({
			"schemaVersion": 1,
			"ok": false,
			"error": "native load_project failed",
			"error_code": load_result,
			"inputs": input_list
		}, evidence_path, 1)
		return

	var files: Array = []
	for file in GDRESettings.get_file_list():
		files.append(String(file))

	var records: Array = []
	for info in GDRESettings.get_import_files(false):
		if info == null:
			continue
		var destinations: Array = []
		for destination in info.get_dest_files():
			destinations.append(String(destination))
		records.append({
			"path": String(info.get_path()),
			"import_md_path": String(info.get_import_md_path()),
			"source_file": String(info.get_source_file()),
			"importer": String(info.get_importer()),
			"type": String(info.get_type()),
			"dest_files": destinations
		})

	_write({
		"schemaVersion": 1,
		"ok": true,
		"file_count": files.size(),
		"import_count": records.size(),
		"files": files,
		"imports": records
	}, evidence_path, 0)


func _write(payload: Dictionary, evidence_path: String, exit_code: int) -> void:
	var file := FileAccess.open(evidence_path, FileAccess.WRITE)
	if file == null:
		push_error("gdre-export-preflight could not open the evidence path")
		quit(3)
		return
	file.store_string(JSON.stringify(payload))
	file.close()
	quit(exit_code)
