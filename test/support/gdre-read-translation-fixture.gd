extends SceneTree

# Test-only fixed reader for generated standalone translation output.
#
# Launch:
#   --headless --script <this file> -- <report.json> <fixture.pck> <output>...
#
# It loads the fixture package read-only, redirects a copied import identity to
# each already-generated output, and returns the complete native message values
# plus the directly loaded locale/messages. Expected values remain literal test
# assertions; this script only exposes observed output.

var _report := {
	"version": 1,
	"ok": false,
	"stage": "read",
	"error": null,
	"userData": OS.get_user_data_dir(),
	"outputs": [],
}


func _initialize() -> void:
	var args: PackedStringArray = OS.get_cmdline_user_args()
	if args.size() < 3:
		_finish("", "read requires a report, a fixture package and at least one output", 2)
		return
	var report_path := String(args[0])
	var package := String(args[1])
	var load_code: int = GDRESettings.load_project(PackedStringArray([package]), true)
	if load_code != OK:
		_finish(report_path, "native load_project failed", load_code)
		return
	var post_code: int = GDRESettings.post_load_patch_translation()
	if post_code != OK:
		GDRESettings.unload_project()
		_finish(report_path, "native post_load_patch_translation failed", post_code)
		return
	var info = GDRESettings.get_import_info_by_source("res://translations.csv")
	if info == null:
		GDRESettings.unload_project()
		_finish(report_path, "native original import metadata is missing", 3)
		return

	for index in range(2, args.size()):
		var path := String(args[index])
		var copy = ImportInfo.copy(info)
		copy.set_dest_files(PackedStringArray([path]))
		var messages = TranslationExporter.get_messages_from_translation(copy)
		if not messages is Dictionary or messages.is_empty():
			GDRESettings.unload_project()
			_finish(report_path, "native complete output messages are unavailable", 4)
			return
		var resource = ResourceCompatLoader.non_global_load(path)
		if resource == null or not resource is OptimizedTranslation:
			GDRESettings.unload_project()
			_finish(report_path, "generated output is not an optimized translation", 5)
			return
		_report["outputs"].append({
			"path": path,
			"class": String(resource.get_class()),
			"locale": String(resource.get_locale()),
			"messages": messages,
			"A": String(resource.get_message("A")),
			"B": String(resource.get_message("B")),
		})

	GDRESettings.unload_project()
	_report["ok"] = true
	_report["stage"] = "complete"
	_write(report_path, 0)


func _finish(report_path: String, message: String, code: int) -> void:
	_report["ok"] = false
	_report["stage"] = "read"
	_report["error"] = message
	_report["nativeCode"] = code
	_write(report_path, 0)


func _write(report_path: String, exit_code: int) -> void:
	if report_path == "":
		push_error("translation fixture reader has no report path")
		quit(2)
		return
	var file := FileAccess.open(report_path, FileAccess.WRITE)
	if file == null:
		push_error("translation fixture reader could not open the report path")
		quit(3)
		return
	file.store_string(JSON.stringify(_report))
	file.close()
	quit(exit_code)
