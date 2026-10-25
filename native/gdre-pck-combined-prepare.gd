extends SceneTree

# Adapter-owned fixed read-only combined translation preparation composition.
#
# Launch:
#   --headless --script <this file> -- <request.json> <report.json>
#
# It loads exactly one source package through the fixed runtime, derives the
# actual native import/resource/default-locale/generated destination identities
# and the optional project configuration registration, then reports the expected
# selected/retained message multisets. It performs no mutation, no extraction,
# no translation serialization and no post-failure scan. Every native return
# value is checked explicitly because GDScript asserts are disabled in the fixed
# release build.
#
# See docs/operation-contract.md §8.2 for the tracked semantic evidence
# requirements.

const REPORT_VERSION := 1
const KEY_COLUMN := "key"
const MISSING_KEY_SENTINEL := "<!MissingKey:"
const LOCALE_PATTERN := "^[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*$"
const RESERVED_DEVICE_PATTERN := "^(?:con|prn|aux|nul|clock\\$|conin\\$|conout\\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\\..*)?$"
const UNSAFE_SEGMENT_CHARS := "<>:\"|?*"

var _request_path := ""
var _report_path := ""
var _report: Dictionary = {}
var _loaded := false

var _source := ""
var _translations: Array = []
var _requested_locales: Array = []
var _source_members := {}
var _ordinary_members: Array = []
var _mappings_report: Array = []
var _existing_locales_report: Array = []
var _outputs: Array = []
var _retained_locales: Array = []
var _generated_entries: Array = []
var _project_config = null


func _initialize() -> void:
	var args: PackedStringArray = OS.get_cmdline_user_args()
	if args.size() != 2:
		push_error("gdre-pck-combined-prepare requires exactly a request and a report path")
		quit(2)
		return
	_request_path = String(args[0])
	_report_path = String(args[1])
	if not _is_absolute_local(_request_path) or not _is_absolute_local(_report_path):
		push_error("gdre-pck-combined-prepare requires absolute request and report paths")
		quit(2)
		return
	if _same_path(_request_path, _report_path):
		push_error("gdre-pck-combined-prepare request and report paths must differ")
		quit(2)
		return

	_report = {
		"version": REPORT_VERSION,
		"ok": false,
		"stage": "startup",
		"error": null,
		"nativeCode": -1,
		"source": "",
		"userData": _normalize_path(OS.get_user_data_dir()),
		"temp": _normalize_path(OS.get_temp_dir()),
		"mappings": [],
		"existingLocales": [],
		"outputs": [],
		"retainedLocales": [],
		"projectConfig": null,
	}

	var request = _read_json(_request_path)
	if request == null:
		_fail("request", "request is not readable JSON", -1)
		return
	if not request is Dictionary:
		_fail("request", "request must be a JSON object", -1)
		return
	if not _validate_request(request):
		return
	if not _validate_evidence_paths():
		return

	var load_code: int = GDRESettings.load_project(PackedStringArray([_source]), true)
	if load_code != OK:
		_fail("load", "native load_project failed", load_code)
		return
	_loaded = true

	var post_code: int = GDRESettings.post_load_patch_translation()
	if post_code != OK:
		_fail("post-load", "native post_load_patch_translation failed", post_code)
		return

	if not _read_project_member():
		return
	if not _derive_outputs():
		return
	if not _validate_destinations():
		return
	if not _read_project_configuration():
		return

	_report["ok"] = true
	_report["stage"] = "complete"
	_report["error"] = null
	_report["nativeCode"] = 0
	_report["mappings"] = _mappings_report
	_report["existingLocales"] = _existing_locales_report
	_report["outputs"] = _outputs
	_report["retainedLocales"] = _retained_locales
	_report["projectConfig"] = _project_config
	_unload()
	_write_report(0)


# --- request admission -----------------------------------------------------

func _validate_request(request: Dictionary) -> bool:
	var allowed := ["version", "source", "translations", "locales", "sourceMembers", "ordinaryMembers"]
	for key in request.keys():
		if not allowed.has(String(key)):
			_fail("request", "request contains an unsupported field", -1)
			return false
	var version_value = request.get("version", null)
	if not _is_integral(version_value) or int(version_value) != REPORT_VERSION:
		_fail("request", "request version must be 1", -1)
		return false

	var source_value = request.get("source", null)
	if not source_value is String or String(source_value) == "":
		_fail("request", "source must be a nonempty string", -1)
		return false
	if not _is_absolute_local(String(source_value)):
		_fail("request", "source must be an absolute local path", -1)
		return false
	_source = String(source_value)
	_report["source"] = _normalize_path(_source)

	if not _validate_translations(request.get("translations", null)):
		return false
	if not _validate_locales(request.get("locales", null)):
		return false
	if not _validate_source_members(request.get("sourceMembers", null)):
		return false
	if not _validate_ordinary_members(request.get("ordinaryMembers", null)):
		return false
	return true


func _validate_translations(value) -> bool:
	if not value is Array or value.is_empty():
		_fail("request", "translations must be a nonempty array", -1)
		return false
	if value.size() != 1:
		_fail("request", "exactly one translation mapping is supported", -1)
		return false
	var resource_folded := {}
	var csv_seen := {}
	for index in range(value.size()):
		var raw = value[index]
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
		if csv_seen.has(_normalize_path(csv)):
			_fail("request", "translation csv paths must not repeat", -1)
			return false
		csv_seen[_normalize_path(csv)] = true

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


func _validate_locales(value) -> bool:
	if not value is Array:
		_fail("request", "locales must be an array", -1)
		return false
	var folded := {}
	for locale_value in value:
		if not locale_value is String or String(locale_value) == "":
			_fail("request", "each locale must be a nonempty string", -1)
			return false
		var locale := String(locale_value)
		if not _is_locale(locale):
			_fail("request", "locale identifiers must use the accepted native locale syntax", -1)
			return false
		if _requested_locales.has(locale):
			_fail("request", "locales must not contain duplicates", -1)
			return false
		if folded.has(locale.to_lower()):
			_fail("request", "locales must not contain case-folded duplicates", -1)
			return false
		folded[locale.to_lower()] = true
		_requested_locales.append(locale)
	return true


func _validate_source_members(value) -> bool:
	if not value is Array:
		_fail("request", "sourceMembers must be an array", -1)
		return false
	for member_value in value:
		if not member_value is String or not _is_inventory_member(String(member_value)):
			_fail("request", "each source member must be a safe res:// inventory identity", -1)
			return false
		_source_members[String(member_value)] = true
	return true


func _validate_ordinary_members(value) -> bool:
	if not value is Array:
		_fail("request", "ordinaryMembers must be an array", -1)
		return false
	for member_value in value:
		if not member_value is String or not _is_safe_member(String(member_value)):
			_fail("request", "each ordinary member must be a safe res:// logical identity", -1)
			return false
		_ordinary_members.append(String(member_value))
	return true


func _validate_evidence_paths() -> bool:
	var inputs: Array = [_source]
	for mapping in _translations:
		inputs.append(String(mapping["csv"]))
	for input in inputs:
		if _same_path(_request_path, String(input)) or _same_path(_report_path, String(input)):
			push_error("gdre-pck-combined-prepare evidence paths must not alias an input")
			quit(2)
			return false
	return true


# --- native identity derivation --------------------------------------------

func _derive_outputs() -> bool:
	var all_infos: Array = []
	for info in GDRESettings.get_import_files(false):
		if info != null:
			all_infos.append(info)
	var existing_members_folded := {}
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
		var ordered_locales: Array = []
		var fallback_locale := _native_fallback_locale()
		var default_locale := ""
		for dest in dest_files:
			if _project_config != null and dest.to_lower() == String(_project_config["member"]).to_lower():
				_fail("validate", "combined destinations contain a duplicate or case-folded collision", -1)
				return false
			var native_resource = ResourceCompatLoader.non_global_load(dest)
			if native_resource == null or not native_resource is OptimizedTranslation:
				_fail("validate", "only compatible optimized translation resources are supported: " + dest, -1)
				return false
			var locale := _translation_locale(native_resource)
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
			ordered_locales.append(locale)
			# Mirror native get_translations: configured fallback first, including
			# the native filename fallback, then the first loaded resource.
			if default_locale == "":
				if locale.to_lower() == fallback_locale.to_lower():
					default_locale = locale
				elif locale == "en" and _resource_filename_locale(native_resource) == fallback_locale.to_lower():
					default_locale = locale
		if default_locale == "":
			default_locale = String(ordered_locales[0])

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

		var expected_values := {}
		var desired_values := {}
		for selected in selected_locales:
			var locale := String(selected)
			var base_locale := locale if locale_destinations.has(locale) else default_locale
			var base_values := _string_array(before[base_locale])
			var base_resource = locale_resources[base_locale]
			var expected: Array = []
			for value in base_values:
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

		_mappings_report.append({
			"resource": resource,
			"csv": String(mapping["csv"]),
			"defaultLocale": default_locale,
			"locales": selected_locales,
		})

		for locale in locale_destinations.keys():
			var existing_member := String(locale_destinations[locale])
			if not existing_members_folded.has(existing_member.to_lower()):
				existing_members_folded[existing_member.to_lower()] = true
				_existing_locales_report.append({
					"locale": String(locale),
					"member": existing_member,
				})
			_generated_entries.append({
				"kind": "existing",
				"member": existing_member,
			})

		for selected in selected_locales:
			var locale := String(selected)
			var member := ""
			var kind := ""
			if locale_destinations.has(locale):
				member = String(locale_destinations[locale])
				kind = "existing"
			else:
				member = _derive_new_locale_member(locale_resources[default_locale], locale)
				kind = "new"
				if member == "":
					_fail("validate", "cannot derive a safe new-locale destination resource from the native default resource path", -1)
					return false
			if not _is_safe_member(member):
				_fail("validate", "derived translation destination is not a safe logical path", -1)
				return false
			if kind == "new":
				_generated_entries.append({"kind": "new", "member": member})
			_outputs.append({
				"resource": resource,
				"member": member,
				"locale": locale,
				"kind": kind,
				"desired": desired_values[locale],
				"expectedValues": expected_values[locale],
			})

		for locale in locale_destinations.keys():
			var existing_locale := String(locale)
			if selected_locales.has(existing_locale):
				continue
			_retained_locales.append({
				"resource": resource,
				"member": String(locale_destinations[existing_locale]),
				"locale": existing_locale,
				"expectedValues": _string_array(before[existing_locale]),
			})
	return true


func _validate_native_csv(csv: String, info, columns: Array, rows: Array) -> int:
	# Runtime-revision fact retained from the accepted standalone composition:
	# this build's get_csv_messages(csv, ImportInfo) returns a column -> value
	# list dictionary rather than the older source signature.
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
	# followed by ".<locale>.translation".
	var default_path := String(default_resource.get_path())
	if default_path == "":
		return ""
	return default_path.get_basename().get_basename() + "." + new_locale + ".translation"


func _translation_setting_key() -> String:
	return "internationalization/locale/translations" if GDRESettings.get_ver_major() >= 4 else "locale/translations"


func _fallback_setting_key() -> String:
	return "internationalization/locale/fallback" if GDRESettings.get_ver_major() >= 4 else "locale/fallback"


func _native_fallback_locale() -> String:
	if GDRESettings.pack_has_project_config() and GDRESettings.is_project_config_loaded():
		var key := _fallback_setting_key()
		if GDRESettings.has_project_setting(key):
			var value = GDRESettings.get_project_setting(key, null)
			if value is String and String(value) != "":
				return String(value)
	return "en"


func _translation_locale(resource) -> String:
	var locale := String(resource.get_locale())
	if locale == "" and not String(resource.get_path()).contains("::"):
		locale = _resource_filename_locale(resource)
	return locale


func _resource_filename_locale(resource) -> String:
	return String(resource.get_path()).get_basename().get_extension().to_lower()


func _validate_destinations() -> bool:
	var folded := {}
	for entry in _generated_entries:
		var key := String(entry["member"]).to_lower()
		if folded.has(key):
			_fail("validate", "combined destinations contain a duplicate or case-folded collision", -1)
			return false
		folded[key] = true

	var generated_and_project: Array = []
	for output in _outputs:
		generated_and_project.append(String(output["member"]))
	if _project_config != null:
		generated_and_project.append(String(_project_config["member"]))
	for member in generated_and_project:
		for ordinary in _ordinary_members:
			if String(member).to_lower() == String(ordinary).to_lower():
				_fail("validate", "a generated destination collides with an ordinary replacement target", -1)
				return false

	for output in _outputs:
		var member := String(output["member"])
		if String(output["kind"]) == "existing":
			if not _source_members.has(member):
				_fail("validate", "an existing-locale destination is absent from sourceMembers", -1)
				return false
		else:
			if _source_members.has(member):
				_fail("validate", "a new-locale destination is already present in sourceMembers", -1)
				return false
	return true


# --- project configuration --------------------------------------------------

func _read_project_member() -> bool:
	if not GDRESettings.pack_has_project_config():
		_project_config = null
		return true
	if not GDRESettings.is_project_config_loaded():
		_fail("validate", "native project configuration metadata is not loaded", -1)
		return false
	var member := String(GDRESettings.get_project_config_path())
	if member == "" or not _is_safe_member(member):
		_fail("validate", "native project configuration path is not a safe logical path", -1)
		return false
	if member.to_lower() != "res://project.godot" and member.to_lower() != "res://project.binary":
		_fail("project", "unsupported project configuration identity: " + member, -1)
		return false
	_generated_entries.append({"kind": "project", "member": member})
	_project_config = {
		"member": member,
		"registration": [],
	}
	return true


func _read_project_configuration() -> bool:
	if _project_config == null:
		return true
	var member := String(_project_config["member"])
	var registration = _read_registration(member)
	if registration == null:
		return false

	var seen := {}
	var folded := {}
	for entry in registration:
		var value := String(entry)
		if seen.has(value):
			_fail("project", "project configuration registration contains a duplicate entry", -1)
			return false
		seen[value] = true
		var fold := value.to_lower()
		if folded.has(fold):
			_fail("project", "project configuration registration contains a case-folded duplicate entry", -1)
			return false
		folded[fold] = true
		if fold == member.to_lower():
			_fail("project", "project configuration registration contains a self-entry", -1)
			return false
		for output in _outputs:
			var output_member := String(output["member"])
			if fold != output_member.to_lower():
				continue
			if value == output_member:
				# The source config may already register the exact destination,
				# including a not-yet-present new-locale resource.
				continue
			_fail("project", "project configuration registration conflicts with a generated destination", -1)
			return false

	var union := {}
	for entry in registration:
		union[String(entry)] = true
	for output in _outputs:
		union[String(output["member"])] = true
	var expected: Array = []
	for key in union.keys():
		expected.append(String(key))
	expected.sort()
	_project_config["registration"] = expected
	return true


func _read_registration(member: String):
	if member.to_lower() != "res://project.godot" and member.to_lower() != "res://project.binary":
		_fail("project", "unsupported project configuration identity: " + member, -1)
		return null
	if not GDRESettings.is_project_config_loaded():
		_fail("project", "native project configuration metadata is not loaded", -1)
		return null
	var setting_key := _translation_setting_key()
	if not GDRESettings.has_project_setting(setting_key):
		# Native project-config behavior treats an absent setting as an empty list.
		return []
	var value = GDRESettings.get_project_setting(setting_key, null)
	var entries: Array = []
	if value is PackedStringArray:
		entries = _string_array(value)
	elif value is Array:
		for entry in value:
			if not entry is String:
				_fail("project", "project configuration registration is not a string array", -1)
				return null
			entries.append(String(entry))
	else:
		_fail("project", "project configuration registration is not a string array", -1)
		return null
	var registration: Array = []
	for entry in entries:
		if not _is_inventory_member(String(entry)):
			_fail("project", "project configuration registration contains an unsafe logical member", -1)
			return null
		registration.append(String(entry))
	return registration


# --- report and helpers -----------------------------------------------------

func _fail(stage: String, message: String, code: int) -> void:
	_report["ok"] = false
	_report["stage"] = stage
	_report["error"] = message
	_report["nativeCode"] = code
	_report["mappings"] = _mappings_report
	_report["existingLocales"] = _existing_locales_report
	_report["outputs"] = _outputs
	_report["retainedLocales"] = _retained_locales
	_report["projectConfig"] = _project_config
	_unload()
	_write_report(0)


func _unload() -> void:
	if _loaded:
		GDRESettings.unload_project()
		_loaded = false


func _write_report(exit_code: int) -> void:
	if _report_aliases_input():
		push_error("gdre-pck-combined-prepare refused to write an unsafe report path")
		quit(3)
		return
	var file := FileAccess.open(_report_path, FileAccess.WRITE)
	if file == null:
		push_error("gdre-pck-combined-prepare could not open the report path")
		quit(3)
		return
	var stored := file.store_string(JSON.stringify(_report))
	file.flush()
	var write_error := file.get_error()
	file.close()
	if not stored or write_error != OK:
		push_error("gdre-pck-combined-prepare could not write the report path")
		quit(3)
		return
	quit(exit_code)


func _report_aliases_input() -> bool:
	if _same_path(_report_path, _source):
		return true
	for mapping in _translations:
		if _same_path(_report_path, String(mapping["csv"])):
			return true
	return false


func _read_json(path: String):
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		return null
	var text := file.get_as_text()
	file.close()
	return JSON.parse_string(text)


func _is_integral(value) -> bool:
	if typeof(value) == TYPE_INT:
		return true
	if typeof(value) == TYPE_FLOAT:
		var number := float(value)
		return is_finite(number) and number == floor(number)
	return false


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
	if value.length() < 3:
		return false
	var drive := value.unicode_at(0)
	if not ((drive >= 65 and drive <= 90) or (drive >= 97 and drive <= 122)):
		return false
	if value.unicode_at(1) != 58:
		return false
	var separator := value.unicode_at(2)
	return separator == 47 or separator == 92


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


func _is_inventory_member(value: String) -> bool:
	# Retained source inventory is not a CLI mapping component: mapping-only
	# restrictions belong to the host planner. Only traversal/ambiguous
	# structure, backslashes and control characters are rejected here.
	if not value.begins_with("res://") or value.contains("\\"):
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


func _normalize_path(value: String) -> String:
	var normalized := value.replace("\\", "/")
	normalized = normalized.simplify_path()
	return normalized


func _same_path(first: String, second: String) -> bool:
	return _normalize_path(first).to_lower() == _normalize_path(second).to_lower()
