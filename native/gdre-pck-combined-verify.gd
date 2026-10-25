extends SceneTree

# Adapter-owned fixed read-only combined translation output verification.
#
# Launch:
#   --headless --script <this file> -- <request.json> <report.json>
#
# It loads exactly one output package through the fixed runtime and verifies the
# generated translation resources through native getters: class, locale, logical
# path, every requested key text and the complete message multiset for selected
# outputs and retained non-target locales. When a project configuration (text
# or binary) is expected it also verifies the actual registration set. It
# performs no mutation, extraction or serialization. Every native return value is checked explicitly
# because GDScript asserts are disabled in the fixed release build.
#
# See docs/operation-contract.md §8.2 for the tracked semantic evidence
# requirements.

const REPORT_VERSION := 1
const MISSING_KEY_SENTINEL := "<!MissingKey:"
const LOCALE_PATTERN := "^[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*$"
const RESERVED_DEVICE_PATTERN := "^(?:con|prn|aux|nul|clock\\$|conin\\$|conout\\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\\..*)?$"
const UNSAFE_SEGMENT_CHARS := "<>:\"|?*"

var _request_path := ""
var _report_path := ""
var _report: Dictionary = {}
var _loaded := false

var _package := ""
var _translations: Array = []
var _retained_locales: Array = []
var _project_request = null
var _outputs_report: Array = []
var _retained_report: Array = []
var _project_report = null


func _initialize() -> void:
	var args: PackedStringArray = OS.get_cmdline_user_args()
	if args.size() != 2:
		push_error("gdre-pck-combined-verify requires exactly a request and a report path")
		quit(2)
		return
	_request_path = String(args[0])
	_report_path = String(args[1])
	if not _is_absolute_local(_request_path) or not _is_absolute_local(_report_path):
		push_error("gdre-pck-combined-verify requires absolute request and report paths")
		quit(2)
		return
	if _same_path(_request_path, _report_path):
		push_error("gdre-pck-combined-verify request and report paths must differ")
		quit(2)
		return

	_report = {
		"version": REPORT_VERSION,
		"ok": false,
		"stage": "startup",
		"error": null,
		"nativeCode": -1,
		"package": "",
		"userData": _normalize_path(OS.get_user_data_dir()),
		"temp": _normalize_path(OS.get_temp_dir()),
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

	var load_code: int = GDRESettings.load_project(PackedStringArray([_package]), true)
	if load_code != OK:
		_fail("load", "native load_project failed", load_code)
		return
	_loaded = true

	var post_code: int = GDRESettings.post_load_patch_translation()
	if post_code != OK:
		_fail("post-load", "native post_load_patch_translation failed", post_code)
		return

	if not _verify_outputs():
		return
	if not _verify_retained_locales():
		return
	if not _verify_project_configuration():
		return

	_report["ok"] = true
	_report["stage"] = "complete"
	_report["error"] = null
	_report["nativeCode"] = 0
	_report["outputs"] = _outputs_report
	_report["retainedLocales"] = _retained_report
	_report["projectConfig"] = _project_report
	_unload()
	_write_report(0)


# --- request admission -----------------------------------------------------

func _validate_request(request: Dictionary) -> bool:
	var allowed := ["version", "package", "translations", "retainedLocales", "projectConfig"]
	for key in request.keys():
		if not allowed.has(String(key)):
			_fail("request", "request contains an unsupported field", -1)
			return false
	var version_value = request.get("version", null)
	if not _is_integral(version_value) or int(version_value) != REPORT_VERSION:
		_fail("request", "request version must be 1", -1)
		return false

	var package_value = request.get("package", null)
	if not package_value is String or String(package_value) == "":
		_fail("request", "package must be a nonempty string", -1)
		return false
	if not _is_absolute_local(String(package_value)):
		_fail("request", "package must be an absolute local path", -1)
		return false
	_package = String(package_value)
	_report["package"] = _normalize_path(_package)

	var translations_value = request.get("translations", null)
	if not translations_value is Array or translations_value.is_empty():
		_fail("request", "translations must be a nonempty array", -1)
		return false
	for raw in translations_value:
		if not raw is Dictionary:
			_fail("request", "each translation verification must be an object", -1)
			return false
		for key in raw.keys():
			if not ["resource", "member", "locale", "desired", "expectedValues"].has(String(key)):
				_fail("request", "translation verification contains an unsupported field", -1)
				return false
		var resource_value = raw.get("resource", null)
		var member_value = raw.get("member", null)
		var locale_value = raw.get("locale", null)
		if not resource_value is String or not _is_safe_member(String(resource_value)):
			_fail("request", "each translation resource must be a safe res:// logical identity", -1)
			return false
		if not member_value is String or not _is_safe_member(String(member_value)):
			_fail("request", "each translation member must be a safe res:// logical identity", -1)
			return false
		if not locale_value is String or not _is_locale(String(locale_value)):
			_fail("request", "each translation locale must use the accepted native locale syntax", -1)
			return false
		var desired_value = raw.get("desired", null)
		if not desired_value is Dictionary:
			_fail("request", "each translation desired map must be an object", -1)
			return false
		var desired := {}
		for key in desired_value.keys():
			var key_value := String(key)
			var text = desired_value[key]
			if key_value == "" or key_value.contains(MISSING_KEY_SENTINEL):
				_fail("request", "translation desired keys must be nonempty and resolved", -1)
				return false
			if not text is String:
				_fail("request", "translation desired values must be strings", -1)
				return false
			desired[key_value] = String(text)
		var expected_value = raw.get("expectedValues", null)
		if not expected_value is Array:
			_fail("request", "each translation expectedValues must be an array", -1)
			return false
		var expected: Array = []
		for item in expected_value:
			if not item is String:
				_fail("request", "translation expectedValues entries must be strings", -1)
				return false
			expected.append(String(item))
		_translations.append({
			"resource": String(resource_value),
			"member": String(member_value),
			"locale": String(locale_value),
			"desired": desired,
			"expectedValues": expected,
		})

	var retained_value = request.get("retainedLocales", null)
	if not retained_value is Array:
		_fail("request", "retainedLocales must be an array", -1)
		return false
	for raw in retained_value:
		if not raw is Dictionary:
			_fail("request", "each retained locale must be an object", -1)
			return false
		for key in raw.keys():
			if not ["resource", "member", "locale", "expectedValues"].has(String(key)):
				_fail("request", "retained locale contains an unsupported field", -1)
				return false
		var resource_value = raw.get("resource", null)
		var member_value = raw.get("member", null)
		var locale_value = raw.get("locale", null)
		if not resource_value is String or not _is_safe_member(String(resource_value)):
			_fail("request", "each retained resource must be a safe res:// logical identity", -1)
			return false
		if not member_value is String or not _is_safe_member(String(member_value)):
			_fail("request", "each retained member must be a safe res:// logical identity", -1)
			return false
		if not locale_value is String or not _is_locale(String(locale_value)):
			_fail("request", "each retained locale must use the accepted native locale syntax", -1)
			return false
		var expected_value = raw.get("expectedValues", null)
		if not expected_value is Array:
			_fail("request", "each retained expectedValues must be an array", -1)
			return false
		var expected: Array = []
		for item in expected_value:
			if not item is String:
				_fail("request", "retained expectedValues entries must be strings", -1)
				return false
			expected.append(String(item))
		_retained_locales.append({
			"resource": String(resource_value),
			"member": String(member_value),
			"locale": String(locale_value),
			"expectedValues": expected,
		})

	var project_value = request.get("projectConfig", null)
	if project_value == null:
		_project_request = null
	elif project_value is Dictionary:
		for key in project_value.keys():
			if not ["member", "registration"].has(String(key)):
				_fail("request", "projectConfig contains an unsupported field", -1)
				return false
		var member_value = project_value.get("member", null)
		if not member_value is String or not _is_safe_member(String(member_value)):
			_fail("request", "projectConfig member must be a safe res:// logical identity", -1)
			return false
		var registration_value = project_value.get("registration", null)
		if not registration_value is Array:
			_fail("request", "projectConfig registration must be an array", -1)
			return false
		var registration: Array = []
		for item in registration_value:
			if not item is String or not _is_inventory_member(String(item)):
				_fail("request", "projectConfig registration entries must be safe res:// logical identities", -1)
				return false
			registration.append(String(item))
		_project_request = {
			"member": String(member_value),
			"registration": registration,
		}
	else:
		_fail("request", "projectConfig must be null or an object", -1)
		return false
	return true


func _validate_evidence_paths() -> bool:
	if _same_path(_request_path, _package) or _same_path(_report_path, _package):
		push_error("gdre-pck-combined-verify evidence paths must not alias the package")
		quit(2)
		return false
	return true


# --- native getter verification --------------------------------------------

func _verify_outputs() -> bool:
	for item in _translations:
		var resource := String(item["resource"])
		var member := String(item["member"])
		var locale := String(item["locale"])
		var info = _native_import_info(resource)
		if info == null:
			return false
		if not GDRESettings.has_path_loaded(member):
			_fail("verify", "selected output member is absent from the package: " + member, -1)
			return false
		var native_resource = ResourceCompatLoader.non_global_load(member)
		if native_resource == null or not native_resource is OptimizedTranslation:
			_fail("verify", "selected output is not a compatible optimized translation: " + member, -1)
			return false
		if String(native_resource.get_class()) != "OptimizedTranslation":
			_fail("verify", "selected output class does not match OptimizedTranslation: " + member, -1)
			return false
		if String(native_resource.get_path()) != member:
			_fail("verify", "selected output native path does not match the requested member: " + member, -1)
			return false
		if String(native_resource.get_locale()) != locale:
			_fail("verify", "selected output locale does not match the requested locale: " + member, -1)
			return false

		var desired: Dictionary = item["desired"]
		var verified_texts := 0
		for key in desired.keys():
			if String(native_resource.get_message(String(key))) != String(desired[key]):
				_fail("verify", "selected output did not retain the requested key text: " + member, -1)
				return false
			verified_texts += 1

		if not _verify_multiset(info, member, locale, item["expectedValues"]):
			return false

		_outputs_report.append({
			"resource": resource,
			"member": member,
			"locale": locale,
			"class": String(native_resource.get_class()),
			"verifiedTexts": verified_texts,
			"retainedContentVerified": true,
		})
	return true


func _verify_retained_locales() -> bool:
	for item in _retained_locales:
		var resource := String(item["resource"])
		var member := String(item["member"])
		var locale := String(item["locale"])
		var info = _native_import_info(resource)
		if info == null:
			return false
		if not GDRESettings.has_path_loaded(member):
			_fail("verify", "retained locale member is absent from the package: " + member, -1)
			return false
		var native_resource = ResourceCompatLoader.non_global_load(member)
		if native_resource == null or not native_resource is OptimizedTranslation:
			_fail("verify", "retained locale member is not a compatible optimized translation: " + member, -1)
			return false
		if _translation_locale(native_resource) != locale:
			_fail("verify", "retained locale member locale does not match the requested locale: " + member, -1)
			return false
		if not _verify_multiset(info, member, locale, item["expectedValues"]):
			return false
		_retained_report.append({
			"resource": resource,
			"member": member,
			"locale": locale,
			"retainedContentVerified": true,
		})
	return true


func _native_import_info(resource: String):
	var all_infos: Array = []
	for info in GDRESettings.get_import_files(false):
		if info != null:
			all_infos.append(info)
	var matches: Array = []
	for info in all_infos:
		if String(info.get_source_file()).to_lower() == resource.to_lower():
			matches.append(info)
	if matches.size() == 0:
		_fail("verify", "translation resource has no unique native import metadata: " + resource, -1)
		return null
	if matches.size() > 1:
		_fail("verify", "translation resource maps to duplicate native import metadata: " + resource, -1)
		return null
	var info = matches[0]
	if String(info.get_source_file()) != resource:
		_fail("verify", "translation resource is not an exact native import source identity: " + resource, -1)
		return null
	if String(info.get_importer()) != "csv_translation" or String(info.get_type()) != "Translation":
		_fail("verify", "only compatible csv_translation Translation imports are supported: " + resource, -1)
		return null
	return info


func _verify_multiset(info, member: String, locale: String, expected_value) -> bool:
	var copy = ImportInfo.copy(info)
	copy.set_dest_files(PackedStringArray([member]))
	var readback = TranslationExporter.get_messages_from_translation(copy)
	if not readback is Dictionary or readback.is_empty():
		_fail("verify", "native complete output messages are unavailable: " + member, -1)
		return false
	var readback_keys: Array = []
	for key in readback.keys():
		readback_keys.append(String(key))
	if readback_keys.size() != 1 or readback_keys[0] != locale:
		_fail("verify", "native complete output messages do not match the requested locale: " + member, -1)
		return false
	var actual_values := _string_array(readback[locale])
	var expected_values := _string_array(expected_value)
	actual_values.sort()
	expected_values.sort()
	if actual_values != expected_values:
		_fail("verify", "native retained message multiset does not match the expected values: " + member, -1)
		return false
	return true


# --- project configuration --------------------------------------------------

func _verify_project_configuration() -> bool:
	if _project_request == null:
		if GDRESettings.pack_has_project_config():
			_fail("project", "unexpected project configuration is present", -1)
			return false
		_project_report = null
		return true
	if not GDRESettings.pack_has_project_config() or not GDRESettings.is_project_config_loaded():
		_fail("project", "expected project configuration is absent or not loaded", -1)
		return false
	var actual_member := String(GDRESettings.get_project_config_path())
	var expected_member := String(_project_request["member"])
	if actual_member.to_lower() != "res://project.godot" and actual_member.to_lower() != "res://project.binary":
		_fail("project", "unsupported project configuration identity: " + actual_member, -1)
		return false
	if actual_member != expected_member:
		_fail("project", "actual project configuration member does not match the expected identity", -1)
		return false
	var registration = _read_registration(actual_member)
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
		if fold == actual_member.to_lower():
			_fail("project", "project configuration registration contains a self-entry", -1)
			return false

	var expected_seen := {}
	for entry in _project_request["registration"]:
		expected_seen[String(entry)] = true
	if seen.size() != expected_seen.size():
		_fail("project", "project configuration registration set does not match the expected registration", -1)
		return false
	for entry in expected_seen.keys():
		if not seen.has(String(entry)):
			_fail("project", "project configuration registration set does not match the expected registration", -1)
			return false

	var sorted_registration: Array = []
	for entry in registration:
		sorted_registration.append(String(entry))
	sorted_registration.sort()
	_project_report = {
		"member": actual_member,
		"registration": sorted_registration,
	}
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


func _translation_setting_key() -> String:
	return "internationalization/locale/translations" if GDRESettings.get_ver_major() >= 4 else "locale/translations"


# --- report and helpers -----------------------------------------------------

func _fail(stage: String, message: String, code: int) -> void:
	_report["ok"] = false
	_report["stage"] = stage
	_report["error"] = message
	_report["nativeCode"] = code
	_report["outputs"] = _outputs_report
	_report["retainedLocales"] = _retained_report
	_report["projectConfig"] = _project_report
	_unload()
	_write_report(0)


func _unload() -> void:
	if _loaded:
		GDRESettings.unload_project()
		_loaded = false


func _write_report(exit_code: int) -> void:
	if _same_path(_report_path, _package):
		push_error("gdre-pck-combined-verify refused to write an unsafe report path")
		quit(3)
		return
	var file := FileAccess.open(_report_path, FileAccess.WRITE)
	if file == null:
		push_error("gdre-pck-combined-verify could not open the report path")
		quit(3)
		return
	var stored := file.store_string(JSON.stringify(_report))
	file.flush()
	var write_error := file.get_error()
	file.close()
	if not stored or write_error != OK:
		push_error("gdre-pck-combined-verify could not write the report path")
		quit(3)
		return
	quit(exit_code)


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


func _matches(pattern: String, value: String) -> bool:
	var regex := RegEx.new()
	if regex.compile(pattern) != OK:
		return false
	var match := regex.search(value)
	return match != null and match.get_string() == value


func _is_locale(value: String) -> bool:
	return _matches(LOCALE_PATTERN, value)


func _translation_locale(resource) -> String:
	# Mirror native get_translation_locale: an empty resource locale with no
	# subresource identity falls back to the filename extension.
	var locale := String(resource.get_locale())
	if locale == "" and not String(resource.get_path()).contains("::"):
		locale = _resource_filename_locale(resource)
	return locale


func _resource_filename_locale(resource) -> String:
	return String(resource.get_path()).get_basename().get_extension().to_lower()


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
