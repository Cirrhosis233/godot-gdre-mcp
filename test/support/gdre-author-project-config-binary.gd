extends SceneTree

# Test-only fixed author for a binary project configuration fixture.
#
# Launch:
#   --headless --script <this file> -- <text fixture.pck> <output directory> <report.json>
#
# It loads the authored text project.godot package with the existing runtime,
# then uses GDRESettings.save_project_config_binary to produce project.binary.
# This is fixture preparation through existing native capability, not a new
# encoder or toolchain. Every native return is checked explicitly.

var _report := {
	"version": 1,
	"ok": false,
	"stage": "author-binary-config",
	"error": null,
	"userData": OS.get_user_data_dir(),
	"configPath": "",
	"binaryPath": "",
	"bytes": 0,
	"magic": "",
}


func _initialize() -> void:
	var args: PackedStringArray = OS.get_cmdline_user_args()
	if args.size() != 3:
		_finish("", "binary project config author requires a package, output directory and report", 2)
		return
	var package := String(args[0])
	var output_directory := String(args[1])
	var report_path := String(args[2])
	var load_code: int = GDRESettings.load_project(PackedStringArray([package]), true)
	if load_code != OK:
		_finish(report_path, "native load_project failed", load_code)
		return
	var post_code: int = GDRESettings.post_load_patch_translation()
	if post_code != OK:
		GDRESettings.unload_project()
		_finish(report_path, "native post_load_patch_translation failed", post_code)
		return
	if not GDRESettings.pack_has_project_config():
		GDRESettings.unload_project()
		_finish(report_path, "text fixture package does not contain a project configuration", 3)
		return
	if not GDRESettings.is_project_config_loaded():
		GDRESettings.unload_project()
		_finish(report_path, "native project configuration metadata is not loaded", 4)
		return
	_report["configPath"] = String(GDRESettings.get_project_config_path())
	if _report["configPath"] != "res://project.godot":
		GDRESettings.unload_project()
		_finish(report_path, "text fixture project configuration path is not res://project.godot", 5)
		return
	var save_code: int = GDRESettings.save_project_config_binary(output_directory)
	if save_code != OK:
		GDRESettings.unload_project()
		_finish(report_path, "native binary project configuration save failed", save_code)
		return
	var binary_path := output_directory.path_join("project.binary")
	var file := FileAccess.open(binary_path, FileAccess.READ)
	if file == null:
		GDRESettings.unload_project()
		_finish(report_path, "binary project configuration output is unreadable", 6)
		return
	var bytes := file.get_length()
	var magic: String = file.get_buffer(4).get_string_from_ascii()
	file.close()
	GDRESettings.unload_project()
	if bytes <= 0 or magic != "ECFG":
		_finish(report_path, "binary project configuration output is empty or has the wrong magic", 7)
		return
	_report["binaryPath"] = binary_path
	_report["bytes"] = bytes
	_report["magic"] = magic
	_report["ok"] = true
	_report["stage"] = "complete"
	_write(report_path, 0)


func _finish(report_path: String, message: String, code: int) -> void:
	_report["ok"] = false
	_report["stage"] = "author-binary-config"
	_report["error"] = message
	_report["nativeCode"] = code
	_write(report_path, 0)


func _write(report_path: String, exit_code: int) -> void:
	if report_path == "":
		push_error("binary project config author has no report path")
		quit(2)
		return
	var file := FileAccess.open(report_path, FileAccess.WRITE)
	if file == null:
		push_error("binary project config author could not open the report path")
		quit(3)
		return
	file.store_string(JSON.stringify(_report))
	file.close()
	quit(exit_code)
