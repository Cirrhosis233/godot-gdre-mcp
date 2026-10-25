extends SceneTree

# Adapter-owned fixed transaction for gdre_patch_translations.
#
# Launch:
#   --headless --script <this file> -- <request.json> <report.json> [--key=HEX]
#
# The request and report are fixed sibling evidence files under one operation.
# This script loads the requested package/project read-only, validates every
# mapping and every prospective output path before mutation, invokes the
# existing native translation patching functions, then reloads each generated
# resource and verifies both the requested text and the complete retained
# message multiset. It performs no key recovery, no encoder work and no
# post-failure output scan.
#
# GDScript asserts are disabled in the fixed release build, so every native
# return value below is checked explicitly.

const REPORT_VERSION := 1
const KEY_COLUMN := "key"
const MISSING_KEY_SENTINEL := "<!MissingKey:"
const LOCALE_PATTERN := "^[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*$"
const HEX_PATTERN := "^[0-9a-fA-F]{64}$"
const RESERVED_DEVICE_PATTERN := "^(?:con|prn|aux|nul|clock\\$|conin\\$|conout\\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\\..*)?$"
const UNSAFE_SEGMENT_CHARS := "<>:\"|?*"

var _request_path := ""
var _report_path := ""
var _expected_profile := ""
var _secret := ""
var _secret_pattern: RegEx = null
var _report: Dictionary = {}
var _loaded := false

var _inputs: Array = []
var _output := ""
var _requested_locales: Array = []
var _session_actions: Array = []
var _translations: Array = []
var _patch_jobs: Array = []
var _expected_outputs: Array = []
var _prospective_outputs: Array = []
var _file_map: Dictionary = {}
var _project_added: Array = []
var _project_entry: Dictionary = {}
var _expected_project_member := ""
var _mappings_report: Array = []
var _outputs_report: Array = []
var _project_config = null


func _initialize() -> void:
	var args: PackedStringArray = OS.get_cmdline_user_args()
	if args.size() < 2:
		push_error("gdre-patch-translations requires a request and a report path")
		quit(2)
		return
	_request_path = String(args[0])
	_report_path = String(args[1])
	if args.size() >= 3:
		var token := String(args[2])
		if not token.begins_with("--key="):
			push_error("gdre-patch-translations received an unexpected native argument")
			quit(2)
			return
		_secret = token.substr("--key=".length())
		if _secret.length() != 64 or not _matches(HEX_PATTERN, _secret):
			push_error("gdre-patch-translations received an invalid encryption key token")
			quit(2)
			return
		_secret_pattern = RegEx.new()
		if _secret_pattern.compile("(?i)" + _secret) != OK:
			push_error("gdre-patch-translations could not compile the key redaction pattern")
			quit(2)
			return
	if args.size() > 3:
		push_error("gdre-patch-translations received unexpected native arguments")
		quit(2)
		return
	if _request_path == "" or _report_path == "":
		push_error("gdre-patch-translations requires nonempty request and report paths")
		quit(2)
		return
	if not _is_absolute_local(_request_path) or not _is_absolute_local(_report_path):
		push_error("gdre-patch-translations requires absolute request and report paths")
		quit(2)
		return
	if _same_path(_request_path, _report_path):
		push_error("gdre-patch-translations request and report paths must differ")
		quit(2)
		return
	var request_directory := _normalize_path(_request_path).get_base_dir()
	var operation_root := request_directory
	if request_directory.get_file() == "translation-patch":
		operation_root = request_directory.get_base_dir()
	_expected_profile = operation_root.path_join("profile")

	_report = {
		"version": REPORT_VERSION,
		"ok": false,
		"stage": "startup",
		"error": null,
		"nativeCode": -1,
		"output": "",
		"userData": _normalized_absolute(OS.get_user_data_dir()),
		"temp": _normalized_absolute(OS.get_temp_dir()),
		"mappings": [],
		"fileMap": {},
		"outputs": [],
		"projectConfig": null,
	}

	# The operation profile is established by the caller before launch. Refuse
	# to load or patch when native state would escape it.
	if not _path_within(OS.get_user_data_dir(), _expected_profile):
		_fail("profile", "native user data directory is outside the operation profile", -1)
		return
	if not _path_within(OS.get_temp_dir(), _expected_profile):
		_fail("profile", "native temporary directory is outside the operation profile", -1)
		return

	var request = _read_json(_request_path)
	if request == null:
		_fail("request", "request is not readable JSON", -1)
		return
	if not _validate_request(request):
		return
	if not _validate_evidence_paths():
		return

	if _secret != "":
		var key_code: int = GDRESettings.set_encryption_key_string(_secret)
		if key_code != OK:
			_fail("key", "native encryption key setup failed", key_code)
			return

	# Apply the ordered session controls before project loading so patching uses
	# the same dedicated native multithreading setting as other commands.
	for action in _session_actions:
		var disabled: bool = bool(action["disabled"])
		GDREConfig.set_setting("force_single_threaded", disabled, true)

	var native_inputs := PackedStringArray()
	for value in _inputs:
		native_inputs.append(String(value))
	var load_code: int = GDRESettings.load_project(native_inputs, true)
	if load_code != OK:
		_fail("load", "native load_project failed", load_code)
		return
	_loaded = true

	var post_code: int = GDRESettings.post_load_patch_translation()
	if post_code != OK:
		_fail("post-load", "native post_load_patch_translation failed", post_code)
		return

	if not _validate_mappings():
		return
	if not _validate_output_paths():
		return
	if not _prepare_output_directory():
		return
	if not _execute_patch():
		return
	if not _verify_outputs():
		return

	_report["ok"] = true
	_report["stage"] = "complete"
	_report["error"] = null
	_report["nativeCode"] = 0
	_report["mappings"] = _mappings_report
	_report["fileMap"] = _file_map
	_report["outputs"] = _outputs_report
	_report["projectConfig"] = _project_config
	_unload()
	_write_report(0)


# --- request admission -----------------------------------------------------

func _validate_request(request: Dictionary) -> bool:
	var allowed := ["version", "inputs", "output", "locales", "session", "translations"]
	for key in request.keys():
		if not allowed.has(String(key)):
			_fail("request", "request contains an unsupported field", -1)
			return false
	if int(request.get("version", 0)) != REPORT_VERSION:
		_fail("request", "request version must be 1", -1)
		return false

	var inputs_value = request.get("inputs", null)
	if not inputs_value is Array or inputs_value.is_empty():
		_fail("request", "inputs must be a nonempty array", -1)
		return false
	for value in inputs_value:
		if not value is String or String(value) == "":
			_fail("request", "each input must be a nonempty string", -1)
			return false
		if not _is_absolute_local(String(value)):
			_fail("request", "each input must be an absolute local path", -1)
			return false
		_inputs.append(String(value))

	var output_value = request.get("output", null)
	if not output_value is String or String(output_value) == "":
		_fail("request", "output must be a nonempty string", -1)
		return false
	if not _is_absolute_local(String(output_value)):
		_fail("request", "output must be an absolute local path", -1)
		return false
	_output = String(output_value)
	_report["output"] = _output

	var locales_value = request.get("locales", null)
	if not locales_value is Array:
		_fail("request", "locales must be an array", -1)
		return false
	var locale_folded := {}
	for value in locales_value:
		if not value is String or String(value) == "":
			_fail("request", "each locale must be a nonempty string", -1)
			return false
		var locale := String(value)
		if not _is_locale(locale):
			_fail("request", "locale identifiers must use the accepted native locale syntax", -1)
			return false
		if _requested_locales.has(locale):
			_fail("request", "locales must not contain duplicates", -1)
			return false
		var folded := locale.to_lower()
		if locale_folded.has(folded):
			_fail("request", "locales must not contain case-folded duplicates", -1)
			return false
		locale_folded[folded] = true
		_requested_locales.append(locale)

	var session_value = request.get("session", null)
	if not session_value is Array:
		_fail("request", "session must be an array", -1)
		return false
	for index in range(session_value.size()):
		var action = session_value[index]
		if not action is Dictionary:
			_fail("request", "each session action must be an object", -1)
			return false
		for key in action.keys():
			if not ["kind", "disabled"].has(String(key)):
				_fail("request", "session action contains an unsupported field", -1)
				return false
		if String(action.get("kind", "")) != "multithreading":
			_fail("request", "only ordered multithreading session actions are supported", -1)
			return false
		if typeof(action.get("disabled", null)) != TYPE_BOOL:
			_fail("request", "multithreading session actions require a boolean disabled value", -1)
			return false
		_session_actions.append({"kind": "multithreading", "disabled": bool(action["disabled"])})

	var translations_value = request.get("translations", null)
	if not translations_value is Array or translations_value.is_empty():
		_fail("request", "translations must be a nonempty array", -1)
		return false

	var csv_folded := {}
	var resource_folded := {}
	for index in range(translations_value.size()):
		var raw = translations_value[index]
		if not raw is Dictionary:
			_fail("request", "each translation mapping must be an object", -1)
			return false
		for key in raw.keys():
			if not ["resource", "csv", "columns", "rows"].has(String(key)):
				_fail("request", "translation mapping contains an unsupported field", -1)
				return false
		var resource_value = raw.get("resource", null)
		var csv_value = raw.get("csv", null)
		if not resource_value is String or not _is_safe_member(String(resource_value)):
			_fail("request", "each translation resource must be a safe res:// logical identity", -1)
			return false
		if not csv_value is String or not _is_absolute_local(String(csv_value)):
			_fail("request", "each translation csv must be an absolute local path", -1)
			return false
		var resource := String(resource_value)
		var csv := String(csv_value)
		if resource_folded.has(resource.to_lower()):
			_fail("request", "translation resources must not repeat under case folding", -1)
			return false
		resource_folded[resource.to_lower()] = true
		if csv_folded.has(_normalize_path(csv)):
			_fail("request", "translation csv paths must not repeat", -1)
			return false
		csv_folded[_normalize_path(csv)] = true

		var columns_value = raw.get("columns", null)
		var rows_value = raw.get("rows", null)
		if not columns_value is Array or columns_value.is_empty():
			_fail("request", "translation columns must be a nonempty array", -1)
			return false
		if not rows_value is Array or rows_value.is_empty():
			_fail("request", "translation rows must be a nonempty array", -1)
			return false

		var columns: Array = []
		var column_folded := {}
		var key_index := -1
		for column_value in columns_value:
			if not column_value is String or String(column_value) == "":
				_fail("request", "translation columns must be nonempty strings", -1)
				return false
			var column := String(column_value)
			if columns.has(column):
				_fail("request", "translation columns must be unique", -1)
				return false
			if column_folded.has(column.to_lower()):
				_fail("request", "translation columns must not repeat under case folding", -1)
				return false
			column_folded[column.to_lower()] = true
			if column == KEY_COLUMN:
				if key_index != -1:
					_fail("request", "translation csv must contain exactly one key column", -1)
					return false
				key_index = columns.size()
			elif not _is_locale(column):
				_fail("request", "translation locale columns must use the accepted native locale syntax", -1)
				return false
			columns.append(column)
		if key_index == -1:
			_fail("request", "translation csv must contain exactly one key column", -1)
			return false
		if columns.size() < 2:
			_fail("request", "translation csv must contain at least one locale column", -1)
			return false

		var rows: Array = []
		var keys_seen := {}
		for row_value in rows_value:
			if not row_value is Array or row_value.size() != columns.size():
				_fail("request", "translation rows must match the declared column width", -1)
				return false
			var row: Array = []
			for cell in row_value:
				if not cell is String:
					_fail("request", "translation cells must be strings", -1)
					return false
				row.append(String(cell))
			var key := String(row[key_index])
			if key == "":
				_fail("request", "translation keys must be nonempty", -1)
				return false
			if key.contains(MISSING_KEY_SENTINEL):
				_fail("request", "translation keys must not contain unresolved missing-key placeholders", -1)
				return false
			if keys_seen.has(key):
				_fail("request", "translation keys must be unique", -1)
				return false
			keys_seen[key] = true
			rows.append(row)

		_translations.append({
			"resource": resource,
			"csv": csv,
			"columns": columns,
			"rows": rows,
			"key_index": key_index,
		})
	return true


func _validate_evidence_paths() -> bool:
	# The report is a fixed evidence file, never an input or output target.
	for input in _inputs:
		if _same_path(_report_path, String(input)) or _same_path(_request_path, String(input)):
			push_error("gdre-patch-translations evidence paths must not alias an input")
			quit(2)
			return false
		if _path_within(_report_path, String(input)):
			push_error("gdre-patch-translations report path must not write inside an input")
			quit(2)
			return false
	if _path_within(_request_path, _output) or _path_within(_report_path, _output):
		push_error("gdre-patch-translations evidence paths must be outside the patch output")
		quit(2)
		return false
	if _normalize_path(_report_path).get_base_dir().to_lower() != _normalize_path(_request_path).get_base_dir().to_lower():
		_fail("request", "request and report must be sibling evidence files", -1)
		return false
	return true


func _report_aliases_input() -> bool:
	for input in _inputs:
		if _same_path(_report_path, String(input)):
			return true
	return false


# --- native mapping and output validation ----------------------------------

func _validate_mappings() -> bool:
	var all_infos: Array = []
	for info in GDRESettings.get_import_files(false):
		if info != null:
			all_infos.append(info)

	for index in range(_translations.size()):
		var mapping: Dictionary = _translations[index]
		var resource := String(mapping["resource"])
		var matches: Array = []
		for info in all_infos:
			if String(info.get_source_file()).to_lower() == resource.to_lower():
				matches.append(info)
		if matches.size() == 0:
			_fail("validate", "translation resource has no unique native import metadata: " + resource, -1)
			return false
		if matches.size() > 1:
			_fail("validate", "translation resource maps to duplicate native import metadata: " + resource, -1)
			return false
		var info = matches[0]
		if String(info.get_source_file()) != resource:
			_fail("validate", "translation resource is not an exact native import source identity: " + resource, -1)
			return false
		if String(info.get_importer()) != "csv_translation" or String(info.get_type()) != "Translation":
			_fail("validate", "only compatible csv_translation Translation imports are supported: " + resource, -1)
			return false

		var dest_files: Array = []
		for destination in info.get_dest_files():
			var dest := String(destination)
			if not _is_safe_member(dest):
				_fail("validate", "native translation destination is not a safe logical path", -1)
				return false
			dest_files.append(dest)
		if dest_files.is_empty():
			_fail("validate", "native translation import has no destination resources: " + resource, -1)
			return false

		var locale_resources := {}
		var locale_destinations := {}
		for dest in dest_files:
			var native_resource = ResourceCompatLoader.non_global_load(dest)
			if native_resource == null or not native_resource is OptimizedTranslation:
				_fail("validate", "only compatible optimized translation resources are supported: " + dest, -1)
				return false
			var locale := String(native_resource.get_locale())
			if not _is_locale(locale):
				_fail("validate", "native translation resource has an unsupported locale identifier", -1)
				return false
			if locale_destinations.has(locale):
				_fail("validate", "native translation import has duplicate locale resources", -1)
				return false
			for existing in locale_destinations.keys():
				if String(existing).to_lower() == locale.to_lower() and String(existing) != locale:
					_fail("validate", "native translation resources contain an ambiguous locale alias", -1)
					return false
			locale_resources[locale] = native_resource
			locale_destinations[locale] = dest

		var before = TranslationExporter.get_messages_from_translation(info)
		if not before is Dictionary or before.is_empty():
			_fail("validate", "native original translation messages are unavailable: " + resource, -1)
			return false
		var before_keys: Array = []
		for key in before.keys():
			before_keys.append(String(key))
			if not locale_destinations.has(String(key)):
				_fail("validate", "native original message locale does not match a destination resource", -1)
				return false
		for locale in locale_destinations.keys():
			if not before_keys.has(String(locale)):
				_fail("validate", "native original message locale is missing from the destination resources", -1)
				return false
		var default_locale := String(before_keys[0])
		if not locale_destinations.has(default_locale):
			_fail("validate", "native default translation locale is not a destination resource", -1)
			return false

		var columns: Array = mapping["columns"]
		var rows: Array = mapping["rows"]
		var key_index := int(mapping["key_index"])
		var selected_locales: Array = []
		if not _requested_locales.is_empty():
			for requested in _requested_locales:
				var locale := String(requested)
				if not columns.has(locale):
					_fail("validate", "explicit locale is absent from the prepared csv columns: " + locale, -1)
					return false
				for original_locale in locale_destinations.keys():
					if String(original_locale).to_lower() == locale.to_lower() and String(original_locale) != locale:
						_fail("validate", "explicit locale changes the canonical spelling of an existing native locale: " + locale, -1)
						return false
				selected_locales.append(locale)
		else:
			for column in columns:
				var column_name := String(column)
				if column_name == KEY_COLUMN:
					continue
				if locale_destinations.has(column_name):
					continue
				for original_locale in locale_destinations.keys():
					if String(original_locale).to_lower() == column_name.to_lower():
						_fail("validate", "csv locale column collides with an existing native locale alias: " + column_name, -1)
						return false
				selected_locales.append(column_name)
			if selected_locales.is_empty():
				_fail("validate", "omitted locales require at least one new locale column: " + resource, -1)
				return false

		if selected_locales.is_empty():
			_fail("validate", "no effective locale was selected for translation resource: " + resource, -1)
			return false
		for selected in selected_locales:
			var selected_locale := String(selected)
			if not _locale_round_trips(selected_locale):
				_fail("validate", "selected locale spelling would be canonicalized by native translation state: " + selected_locale, -1)
				return false

		var base_values := {}
		var expected_values := {}
		var desired_values := {}
		for selected in selected_locales:
			var locale := String(selected)
			var base_locale := locale if locale_destinations.has(locale) else default_locale
			if not base_values.has(base_locale):
				base_values[base_locale] = _string_array(before[base_locale])
			var base_resource = locale_resources[base_locale]
			var expected: Array = []
			for value in base_values[base_locale]:
				expected.append(String(value))
			var desired := {}
			for row_index in range(rows.size()):
				var row: Array = rows[row_index]
				var key := String(row[key_index])
				var original := String(base_resource.get_message(key))
				if original == "":
					_fail("validate", "source key lookup at row " + str(row_index + 1) + " is empty and cannot establish key membership", -1)
					return false
				if not _remove_once(expected, original):
					_fail("validate", "native original message list does not contain the source key value", -1)
					return false
				var column_index := columns.find(locale)
				var replacement := String(row[column_index])
				expected.append(replacement)
				desired[key] = replacement
			expected_values[locale] = expected
			desired_values[locale] = desired

		var csv_agreement := _validate_native_csv(String(mapping["csv"]), info, columns, rows)
		if csv_agreement != OK:
			return false

		var mapping_report := {
			"resource": resource,
			"csv": String(mapping["csv"]),
			"defaultLocale": default_locale,
			"locales": selected_locales,
		}
		_mappings_report.append(mapping_report)

		var job := {
			"resource": resource,
			"csv": String(mapping["csv"]),
			"info": info,
			"default_locale": default_locale,
			"selected_locales": selected_locales,
			"locale_destinations": locale_destinations,
			"expected_values": expected_values,
			"desired_values": desired_values,
		}
		_patch_jobs.append(job)

		for selected in selected_locales:
			var locale := String(selected)
			var member: String
			if locale_destinations.has(locale):
				member = String(locale_destinations[locale])
			else:
				member = _derive_new_locale_member(locale_resources[default_locale], locale)
				if member == "":
					_fail("validate", "cannot derive a safe new-locale destination resource from the native default resource path", -1)
					return false
			if not _is_safe_member(member):
				_fail("validate", "derived translation destination is not a safe logical path", -1)
				return false
			_expected_outputs.append({
				"job": job,
				"resource": resource,
				"member": member,
				"path": _absolute_output_path(member),
				"locale": locale,
				"expected": expected_values[locale],
				"desired": desired_values[locale],
			})
	return true


func _validate_native_csv(csv: String, info, columns: Array, rows: Array) -> int:
	# Runtime-revision fact: this build's get_csv_messages(csv, ImportInfo)
	# returns a column -> value-list dictionary. Older source revisions describe
	# a different parameter/return shape; this is the revision verified here.
	var native_csv = TranslationExporter.get_csv_messages(csv, info)
	if not native_csv is Dictionary:
		_fail("validate", "native csv parsing did not return a column map", -1)
		return 1
	var native_by_column := {}
	for key in native_csv.keys():
		native_by_column[String(key)] = _string_array(native_csv[key])
	if native_by_column.size() != columns.size():
		_fail("validate", "native csv columns do not match the prepared request columns", -1)
		return 1
	for column in columns:
		if not native_by_column.has(String(column)):
			_fail("validate", "native csv columns do not match the prepared request columns", -1)
			return 1

	# The native parser retains one all-empty row for a trailing line ending.
	while native_by_column[String(columns[0])].size() > rows.size():
		var trailing_empty := true
		for column in columns:
			var values: Array = native_by_column[String(column)]
			if values[values.size() - 1] != "":
				trailing_empty = false
				break
		if not trailing_empty:
			break
		for column in columns:
			var values: Array = native_by_column[String(column)]
			values.remove_at(values.size() - 1)
	for column in columns:
		if native_by_column[String(column)].size() != rows.size():
			_fail("validate", "native csv row count does not match the prepared request rows", -1)
			return 1
	for row_index in range(rows.size()):
		var row: Array = rows[row_index]
		for column_index in range(columns.size()):
			var column := String(columns[column_index])
			var values: Array = native_by_column[column]
			if String(values[row_index]) != String(row[column_index]):
				_fail("validate", "native csv parsing does not agree with the prepared request text", -1)
				return 1
	return OK


func _derive_new_locale_member(default_resource, new_locale: String) -> String:
	# Native translation_exporter.cpp composes the new locale from the default
	# translation's actual resource path: path.get_basename().get_basename()
	# followed by ".<locale>.translation". Do not infer a suffix from the
	# dest_files order, which may differ from the native default selection.
	var default_path := String(default_resource.get_path())
	if default_path == "":
		return ""
	return default_path.get_basename().get_basename() + "." + new_locale + ".translation"


func _validate_output_paths() -> bool:
	_prospective_outputs = []
	for output in _expected_outputs:
		_prospective_outputs.append({
			"kind": "translation",
			"member": String(output["member"]),
			"path": String(output["path"]),
		})

	var project_member := ""
	if GDRESettings.pack_has_project_config():
		# Runtime-revision fact (not inferred from old source): after
		# load_project + post_load_patch_translation this release reports the
		# actual project.godot or project.binary member and marks it loaded.
		if not GDRESettings.is_project_config_loaded():
			_fail("validate", "native project configuration metadata is not loaded before patching", -1)
			return false
		project_member = String(GDRESettings.get_project_config_path())
		if project_member == "":
			_fail("validate", "native project configuration path is unavailable before patching", -1)
			return false
		if not _is_safe_member(project_member):
			_fail("validate", "native project configuration path is not a safe logical path", -1)
			return false
		_expected_project_member = project_member
		_prospective_outputs.append({
			"kind": "project",
			"member": project_member,
			"path": _absolute_output_path(project_member),
		})

	var path_folded := {}
	var member_folded := {}
	for index in range(_prospective_outputs.size()):
		var entry: Dictionary = _prospective_outputs[index]
		var path_key := _normalize_path(String(entry["path"]))
		var member_key := String(entry["member"]).to_lower()
		if path_folded.has(path_key) or member_folded.has(member_key):
			_fail("validate", "prospective native outputs contain a duplicate or case-folded collision", -1)
			return false
		path_folded[path_key] = true
		member_folded[member_key] = true

	for first_index in range(_prospective_outputs.size()):
		for second_index in range(first_index + 1, _prospective_outputs.size()):
			var first: Dictionary = _prospective_outputs[first_index]
			var second: Dictionary = _prospective_outputs[second_index]
			if _path_ancestor(String(first["path"]), String(second["path"])) or _path_ancestor(String(second["path"]), String(first["path"])):
				_fail("validate", "prospective native outputs contain a file/ancestor collision", -1)
				return false
			if _logical_ancestor(String(first["member"]), String(second["member"])) or _logical_ancestor(String(second["member"]), String(first["member"])):
				_fail("validate", "prospective native logical members contain a file/ancestor collision", -1)
				return false

	for entry in _prospective_outputs:
		var path := String(entry["path"])
		for input in _inputs:
			var input_path := String(input)
			if _same_path(path, input_path) or _path_within(path, input_path):
				_fail("validate", "prospective native output would write inside an input path", -1)
				return false
		if _same_path(path, _request_path) or _same_path(path, _report_path):
			push_error("gdre-patch-translations evidence path collides with an output path")
			quit(2)
			return false
	return true


func _prepare_output_directory() -> bool:
	if DirAccess.dir_exists_absolute(_output):
		var directory := DirAccess.open(_output)
		if directory == null:
			_fail("prepare", "output directory is not readable", -1)
			return false
		directory.include_hidden = true
		if not directory.get_files().is_empty() or not directory.get_directories().is_empty():
			_fail("prepare", "output directory must be absent or empty before patching", -1)
			return false
	else:
		var made := DirAccess.make_dir_recursive_absolute(_output)
		if made != OK and made != ERR_ALREADY_EXISTS:
			_fail("prepare", "output directory could not be created", made)
			return false
	return true


# --- native patch and verification -----------------------------------------

func _execute_patch() -> bool:
	_file_map = {}
	for job in _patch_jobs:
		var selected := PackedStringArray()
		for locale in job["selected_locales"]:
			selected.append(String(locale))
		var code: int = TranslationExporter.patch_translations(
			_output,
			String(job["csv"]),
			ImportInfo.copy(job["info"]),
			selected,
			_file_map,
		)
		if code != OK:
			_report["mappings"] = _mappings_report
			_report["fileMap"] = _file_map
			_fail("patch", "native patch_translations failed", code)
			return false

	var before_keys: Array = []
	for key in _file_map.keys():
		before_keys.append(String(key))
	if GDRESettings.pack_has_project_config():
		var config_code: int = TranslationExporter.patch_project_config(_output, _file_map)
		if config_code != OK:
			_report["mappings"] = _mappings_report
			_report["fileMap"] = _file_map
			_fail("patch-config", "native patch_project_config failed", config_code)
			return false
		for key in _file_map.keys():
			if not before_keys.has(String(key)):
				_project_added.append(String(key))
		if _project_added.size() > 1:
			_report["mappings"] = _mappings_report
			_report["fileMap"] = _file_map
			_fail("patch-config", "native project configuration produced multiple unexpected outputs", -1)
			return false
		if _project_added.size() == 1:
			var path := String(_project_added[0])
			var member := String(_file_map[path])
			if not _is_safe_member(member):
				_report["mappings"] = _mappings_report
				_report["fileMap"] = _file_map
				_fail("patch-config", "native project configuration path is not a safe logical member", -1)
				return false
			if _expected_project_member != "":
				if member.to_lower() != _expected_project_member.to_lower():
					_report["mappings"] = _mappings_report
					_report["fileMap"] = _file_map
					_fail("patch-config", "native project configuration output does not match the prevalidated logical path", -1)
					return false
				if not _same_path(path, _absolute_output_path(_expected_project_member)):
					_report["mappings"] = _mappings_report
					_report["fileMap"] = _file_map
					_fail("patch-config", "native project configuration output does not match the prevalidated output path", -1)
					return false
			_project_entry = {"path": path, "member": member}
	return true


func _verify_outputs() -> bool:
	var expected_by_member := {}
	var expected_by_path := {}
	for output in _expected_outputs:
		expected_by_member[String(output["member"]).to_lower()] = output
		expected_by_path[_normalize_path(String(output["path"]))] = output

	var actual_translation_keys: Array = []
	for key in _file_map.keys():
		var path := String(key)
		var member := String(_file_map[key])
		var is_expected_output := expected_by_path.has(_normalize_path(path)) or expected_by_member.has(member.to_lower())
		var is_project_output := false
		if not _project_entry.is_empty():
			is_project_output = _same_path(path, String(_project_entry["path"])) or member.to_lower() == String(_project_entry["member"]).to_lower()
		if is_expected_output:
			actual_translation_keys.append(path)
		elif not is_project_output:
			_report["mappings"] = _mappings_report
			_report["fileMap"] = _file_map
			_fail("verify", "native patch produced an unexpected output entry", -1)
			return false
		if not _path_within(path, _output):
			_report["mappings"] = _mappings_report
			_report["fileMap"] = _file_map
			_fail("verify", "native output path is outside the operation output directory", -1)
			return false
		for input in _inputs:
			if _same_path(path, String(input)):
				_report["mappings"] = _mappings_report
				_report["fileMap"] = _file_map
				_fail("verify", "native output path aliases an original input", -1)
				return false

	for output in _expected_outputs:
		var member := String(output["member"])
		var expected_path := String(output["path"])
		var actual_path := ""
		for key in _file_map.keys():
			if _normalize_path(String(key)) == _normalize_path(expected_path):
				actual_path = String(key)
				if String(_file_map[key]).to_lower() != member.to_lower():
					_report["mappings"] = _mappings_report
					_report["fileMap"] = _file_map
					_fail("verify", "native output member does not match the derived logical destination", -1)
					return false
				break
		if actual_path == "":
			_report["mappings"] = _mappings_report
			_report["fileMap"] = _file_map
			_fail("verify", "native patch did not report an expected translation output", -1)
			return false
		if not FileAccess.file_exists(actual_path):
			_report["mappings"] = _mappings_report
			_report["fileMap"] = _file_map
			_fail("verify", "native patch did not create an expected translation output", -1)
			return false
		var size := _file_size(actual_path)
		var digest := _sha256_file(actual_path)
		if size <= 0 or digest == "":
			_report["mappings"] = _mappings_report
			_report["fileMap"] = _file_map
			_fail("verify", "native translation output is empty or unreadable", -1)
			return false

		var native_resource = ResourceCompatLoader.non_global_load(actual_path)
		if native_resource == null or not native_resource is OptimizedTranslation:
			_report["mappings"] = _mappings_report
			_report["fileMap"] = _file_map
			_fail("verify", "native translation output is not a compatible optimized translation", -1)
			return false
		var locale := String(output["locale"])
		if String(native_resource.get_locale()) != locale:
			_report["mappings"] = _mappings_report
			_report["fileMap"] = _file_map
			_fail("verify", "native translation output locale does not match the selected locale", -1)
			return false

		var desired: Dictionary = output["desired"]
		var verified_texts := 0
		for key in desired.keys():
			if String(native_resource.get_message(String(key))) != String(desired[key]):
				_report["mappings"] = _mappings_report
				_report["fileMap"] = _file_map
				_report["outputs"] = _outputs_report
				_fail("verify", "native translation output did not retain the requested key text", -1)
				return false
			verified_texts += 1

		var job: Dictionary = output["job"]
		var copy = ImportInfo.copy(job["info"])
		copy.set_dest_files(PackedStringArray([actual_path]))
		var readback = TranslationExporter.get_messages_from_translation(copy)
		if not readback is Dictionary or readback.is_empty():
			_report["mappings"] = _mappings_report
			_report["fileMap"] = _file_map
			_report["outputs"] = _outputs_report
			_fail("verify", "native complete output messages are unavailable", -1)
			return false
		var readback_keys: Array = []
		for key in readback.keys():
			readback_keys.append(String(key))
		if readback_keys.size() != 1 or readback_keys[0] != locale:
			_report["mappings"] = _mappings_report
			_report["fileMap"] = _file_map
			_report["outputs"] = _outputs_report
			_fail("verify", "native complete output messages do not match the selected locale", -1)
			return false
		var actual_values := _string_array(readback[locale])
		var expected_values := _string_array(output["expected"])
		actual_values.sort()
		expected_values.sort()
		if actual_values != expected_values:
			_report["mappings"] = _mappings_report
			_report["fileMap"] = _file_map
			_report["outputs"] = _outputs_report
			_fail("verify", "native retained message multiset does not match the requested replacement", -1)
			return false

		_outputs_report.append({
			"resource": String(output["resource"]),
			"member": member,
			"path": actual_path,
			"locale": locale,
			"class": String(native_resource.get_class()),
			"bytes": size,
			"sha256": digest,
			"verifiedTexts": verified_texts,
			"retainedContentVerified": true,
		})

	if actual_translation_keys.size() != _expected_outputs.size():
		_report["mappings"] = _mappings_report
		_report["fileMap"] = _file_map
		_report["outputs"] = _outputs_report
		_fail("verify", "native patch produced an unexpected translation output inventory", -1)
		return false

	var total_entries := _expected_outputs.size()
	if not _project_entry.is_empty():
		total_entries += 1
		var path := String(_project_entry["path"])
		if not FileAccess.file_exists(path):
			_report["mappings"] = _mappings_report
			_report["fileMap"] = _file_map
			_report["outputs"] = _outputs_report
			_fail("verify", "native project configuration output was not created", -1)
			return false
		var size := _file_size(path)
		var digest := _sha256_file(path)
		if size <= 0 or digest == "":
			_report["mappings"] = _mappings_report
			_report["fileMap"] = _file_map
			_report["outputs"] = _outputs_report
			_fail("verify", "native project configuration output is empty or unreadable", -1)
			return false
		_project_config = {
			"member": String(_project_entry["member"]),
			"path": path,
			"sha256": digest,
		}
	if _file_map.size() != total_entries:
		_report["mappings"] = _mappings_report
		_report["fileMap"] = _file_map
		_report["outputs"] = _outputs_report
		_fail("verify", "native patch reported unexpected extra output entries", -1)
		return false
	return true


# --- report and path helpers ------------------------------------------------

func _fail(stage: String, message: String, code: int) -> void:
	_report["ok"] = false
	_report["stage"] = stage
	_report["error"] = message
	_report["nativeCode"] = code
	_report["mappings"] = _mappings_report
	_report["fileMap"] = _file_map
	_report["outputs"] = _outputs_report
	_report["projectConfig"] = _project_config
	_unload()
	_write_report(0)


func _unload() -> void:
	if _loaded:
		GDRESettings.unload_project()
		_loaded = false


func _write_report(exit_code: int) -> void:
	if _report_aliases_input():
		push_error("gdre-patch-translations refused to write an unsafe report path")
		quit(3)
		return
	var payload = _redact_value(_report)
	var file := FileAccess.open(_report_path, FileAccess.WRITE)
	if file == null:
		push_error("gdre-patch-translations could not open the report path")
		quit(3)
		return
	file.store_string(JSON.stringify(payload))
	file.close()
	quit(exit_code)


func _redact_value(value):
	if value is String:
		var text := String(value)
		if _secret_pattern != null:
			text = _secret_pattern.sub(text, "[redacted]", true)
		return text
	if value is Array:
		var items: Array = []
		for item in value:
			items.append(_redact_value(item))
		return items
	if value is Dictionary:
		var result := {}
		for key in value.keys():
			result[_redact_value(String(key))] = _redact_value(value[key])
		return result
	return value


func _read_json(path: String):
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		return null
	var text := file.get_as_text()
	file.close()
	return JSON.parse_string(text)


func _string_array(value) -> Array:
	var result: Array = []
	if value is PackedStringArray:
		for item in value:
			result.append(String(item))
	elif value is Array:
		for item in value:
			result.append(String(item))
	return result


func _remove_once(values: Array, target: String) -> bool:
	for index in range(values.size()):
		if String(values[index]) == target:
			values.remove_at(index)
			return true
	return false


func _matches(pattern: String, value: String) -> bool:
	var regex := RegEx.new()
	if regex.compile(pattern) != OK:
		return false
	var match := regex.search(value)
	return match != null and match.get_string() == value


func _is_locale(value: String) -> bool:
	return _matches(LOCALE_PATTERN, value)


func _locale_round_trips(value: String) -> bool:
	var probe := Translation.new()
	if probe == null:
		return false
	probe.set_locale(value)
	return String(probe.get_locale()) == value


func _is_absolute_local(value: String) -> bool:
	var normalized := _normalize_path(value)
	if normalized.begins_with("/"):
		return true
	if normalized.length() < 3:
		return false
	return normalized.unicode_at(1) == 58 and normalized.unicode_at(2) == 47


func _is_safe_member(value: String) -> bool:
	if not value.begins_with("res://") or value.contains("\\"):
		return false
	var relative := value.substr(6)
	if relative == "" or relative.begins_with("/"):
		return false
	var segments := relative.split("/")
	for segment in segments:
		if segment == "" or segment == "." or segment == "..":
			return false
		if segment.ends_with(".") or segment.ends_with(" ") or segment.ends_with(":"):
			return false
		if _matches(RESERVED_DEVICE_PATTERN, segment.to_lower()):
			return false
		for index in range(segment.length()):
			var code := segment.unicode_at(index)
			if code < 32 or code == 127:
				return false
			if UNSAFE_SEGMENT_CHARS.contains(segment.substr(index, 1)):
				return false
	return true


func _normalize_path(value: String) -> String:
	var normalized := value.replace("\\", "/")
	normalized = normalized.simplify_path()
	return normalized


func _normalized_absolute(value: String) -> String:
	return _normalize_path(value)


func _same_path(first: String, second: String) -> bool:
	return _normalize_path(first).to_lower() == _normalize_path(second).to_lower()


func _path_within(child: String, parent: String) -> bool:
	var child_path := _normalize_path(child).to_lower()
	var parent_path := _normalize_path(parent).to_lower()
	while parent_path.ends_with("/"):
		parent_path = parent_path.substr(0, parent_path.length() - 1)
	if child_path == parent_path:
		return true
	return child_path.begins_with(parent_path + "/")


func _path_ancestor(parent: String, child: String) -> bool:
	var parent_path := _normalize_path(parent).to_lower()
	var child_path := _normalize_path(child).to_lower()
	return child_path.begins_with(parent_path + "/")


func _logical_ancestor(parent: String, child: String) -> bool:
	var parent_value := parent.to_lower()
	var child_value := child.to_lower()
	return child_value.begins_with(parent_value + "/")


func _absolute_output_path(member: String) -> String:
	return _normalize_path(_output).path_join(member.substr(6))


func _file_size(path: String) -> int:
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		return 0
	var size := file.get_length()
	file.close()
	return size


func _sha256_file(path: String) -> String:
	var bytes := FileAccess.get_file_as_bytes(path)
	if bytes.is_empty():
		return ""
	var context := HashingContext.new()
	if context.start(HashingContext.HASH_SHA256) != OK:
		return ""
	if context.update(bytes) != OK:
		return ""
	return context.finish().hex_encode()
