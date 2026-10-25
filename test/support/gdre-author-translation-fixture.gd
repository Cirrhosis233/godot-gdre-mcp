extends SceneTree

# Test-only fixed author for the static optimized-translation fixture.
#
# Launch:
#   --headless --script <this file> -- <source directory> <report.json>
#
# It reads the authored static `.tres` resources, checks their literal message
# values, converts them with the existing extractor and saves them with the
# existing compatibility saver. It performs no table generation and uses only
# explicit return checks (GDScript asserts are disabled in this build).

var _report := {
	"version": 1,
	"ok": false,
	"stage": "author",
	"error": null,
	"userData": OS.get_user_data_dir(),
	"entries": [],
}


func _initialize() -> void:
	var args: PackedStringArray = OS.get_cmdline_user_args()
	if args.size() != 2:
		_finish("author requires a source directory and a report path", 2)
		return
	var source := String(args[0])
	var report_path := String(args[1])
	var expected := {
		"en": {"A": "old", "B": "keep"},
		"zh": {"A": "旧值", "B": "保留"},
	}
	for locale in ["en", "zh"]:
		var tres := source.path_join(locale + ".tres")
		var resource = ResourceLoader.load(tres, "", ResourceLoader.CACHE_MODE_IGNORE)
		if resource == null or not resource is OptimizedTranslation:
			_finish("authored static resource is not an optimized translation: " + locale, 3)
			return
		for key in expected[locale].keys():
			var actual := String(resource.get_message(String(key)))
			if actual != String(expected[locale][key]):
				_finish("authored static resource message does not match the literal fixture: " + locale, 4)
				return
		var extractor = OptimizedTranslationExtractor.create_from(resource)
		if extractor == null:
			_finish("native extractor conversion failed: " + locale, 5)
			return
		var output := source.path_join(locale + ".translation")
		var saved: int = ResourceCompatLoader.save_custom(extractor, output, 4, 4, 0)
		if saved != OK:
			_finish("native compatibility save failed: " + locale, saved)
			return
		_report["entries"].append({
			"locale": locale,
			"class": String(resource.get_class()),
			"A": String(resource.get_message("A")),
			"B": String(resource.get_message("B")),
			"save": saved,
		})
	_report["ok"] = true
	_report["stage"] = "complete"
	_write(report_path, 0)


func _finish(message: String, code: int) -> void:
	_report["ok"] = false
	_report["stage"] = "author"
	_report["error"] = message
	_report["nativeCode"] = code
	var args: PackedStringArray = OS.get_cmdline_user_args()
	var report_path := String(args[1]) if args.size() >= 2 else ""
	_write(report_path, 0)


func _write(report_path: String, exit_code: int) -> void:
	if report_path == "":
		push_error("translation fixture author has no report path")
		quit(2)
		return
	var file := FileAccess.open(report_path, FileAccess.WRITE)
	if file == null:
		push_error("translation fixture author could not open the report path")
		quit(3)
		return
	file.store_string(JSON.stringify(_report))
	file.close()
	quit(exit_code)
