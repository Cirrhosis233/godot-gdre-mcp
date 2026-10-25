import { pathIdentity } from "./paths.js";
import { isSafeTranslationLocale } from "./schemas.js";

/**
 * Fixed combined translation/package-patch request and report contract.
 *
 * This module owns only the strict JSON shapes of the adapter-owned native
 * preparation/verification scripts and their host-side consistency checks. It
 * never reads files, launches processes or mutates packages. Operation-local
 * staging, fingerprints and lifecycle evidence stay in `pck-patch-operation.ts`;
 * Execution owns the owned launches.
 */

export const PCK_COMBINED_PREPARATION_NAMESPACE = "pck-combined-preparation";
export const PCK_COMBINED_VERIFICATION_NAMESPACE = "pck-combined-verification";
export const PCK_COMBINED_REQUEST_FILE = "request.json";
export const PCK_COMBINED_REPORT_FILE = "report.json";
export const PCK_COMBINED_REPORT_VERSION = 1;

export class CombinedReportError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CombinedReportError";
  }
}

export interface CombinedTranslationRequest {
  readonly resource: string;
  readonly csv: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface CombinedOwnedEnvironment {
  readonly userData: string;
  /** Owned profile temp spellings (TEMP and TMP); the native pick is platform-dependent. */
  readonly temp: readonly string[];
}

export interface CombinedPreparationExpectation {
  readonly source: string;
  readonly translation: CombinedTranslationRequest;
  readonly locales: readonly string[];
  readonly sourceMembers: readonly string[];
  readonly ordinaryMembers: readonly string[];
  readonly ownedEnvironment: CombinedOwnedEnvironment;
}

export interface CombinedMappingReport {
  readonly resource: string;
  readonly csv: string;
  readonly defaultLocale: string;
  readonly locales: readonly string[];
}

export interface CombinedExistingLocale {
  readonly locale: string;
  readonly member: string;
}

export interface CombinedOutput {
  readonly resource: string;
  readonly member: string;
  readonly locale: string;
  readonly kind: "existing" | "new";
  readonly desired: Readonly<Record<string, string>>;
  readonly expectedValues: readonly string[];
}

export interface CombinedRetainedLocale {
  readonly resource: string;
  readonly member: string;
  readonly locale: string;
  readonly expectedValues: readonly string[];
}

export interface CombinedProjectConfig {
  readonly member: string;
  readonly registration: readonly string[];
}

export interface CombinedPrepareReport {
  readonly version: 1;
  readonly ok: boolean;
  readonly stage: string;
  readonly error: string | null;
  readonly nativeCode: number;
  readonly source: string;
  readonly userData: string;
  readonly temp: string;
  readonly mappings: readonly CombinedMappingReport[];
  readonly existingLocales: readonly CombinedExistingLocale[];
  readonly outputs: readonly CombinedOutput[];
  readonly retainedLocales: readonly CombinedRetainedLocale[];
  readonly projectConfig: CombinedProjectConfig | null;
}

export interface CombinedVerifiedOutput {
  readonly resource: string;
  readonly member: string;
  readonly locale: string;
  readonly class: string;
  readonly verifiedTexts: number;
  readonly retainedContentVerified: boolean;
}

export interface CombinedVerifiedRetainedLocale {
  readonly resource: string;
  readonly member: string;
  readonly locale: string;
  readonly retainedContentVerified: boolean;
}

export interface CombinedVerificationReport {
  readonly version: 1;
  readonly ok: boolean;
  readonly stage: string;
  readonly error: string | null;
  readonly nativeCode: number;
  readonly package: string;
  readonly userData: string;
  readonly temp: string;
  readonly outputs: readonly CombinedVerifiedOutput[];
  readonly retainedLocales: readonly CombinedVerifiedRetainedLocale[];
  readonly projectConfig: CombinedProjectConfig | null;
}

export interface CombinedVerificationExpectation {
  readonly package: string;
  readonly outputs: readonly CombinedOutput[];
  readonly retainedLocales: readonly CombinedRetainedLocale[];
  readonly projectConfig: CombinedProjectConfig | null;
  readonly ownedEnvironment: CombinedOwnedEnvironment;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void => {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new CombinedReportError(
        `${label} contains unknown field ${JSON.stringify(key)}`,
      );
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) {
      throw new CombinedReportError(
        `${label} is missing field ${JSON.stringify(key)}`,
      );
    }
  }
};

const requireString = (
  value: Record<string, unknown>,
  field: string,
  label: string,
): string => {
  const entry = value[field];
  if (typeof entry !== "string" || entry.length === 0) {
    throw new CombinedReportError(`${label}.${field} must be a nonempty string`);
  }
  return entry;
};

const requireInteger = (
  value: Record<string, unknown>,
  field: string,
  label: string,
): number => {
  const entry = value[field];
  if (typeof entry !== "number" || !Number.isSafeInteger(entry)) {
    throw new CombinedReportError(`${label}.${field} must be a safe integer`);
  }
  return entry;
};

const requireArray = (
  value: Record<string, unknown>,
  field: string,
  label: string,
): readonly unknown[] => {
  const entry = value[field];
  if (!Array.isArray(entry)) {
    throw new CombinedReportError(`${label}.${field} must be an array`);
  }
  return entry;
};

const requireStringArray = (
  value: unknown,
  label: string,
): readonly string[] => {
  if (!Array.isArray(value)) {
    throw new CombinedReportError(`${label} must be an array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new CombinedReportError(`${label}[${String(index)}] must be a string`);
    }
    return entry;
  });
};

const requireBoolean = (
  value: Record<string, unknown>,
  field: string,
  label: string,
): boolean => {
  const entry = value[field];
  if (typeof entry !== "boolean") {
    throw new CombinedReportError(`${label}.${field} must be boolean`);
  }
  return entry;
};

const RESERVED_DEVICE_PATTERN =
  /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;
const UNSAFE_SEGMENT_CHARS = /[<>:"|?*]/u;

const inventorySegments = (value: string): readonly string[] | null => {
  if (!value.startsWith("res://") || value.includes("\\")) return null;
  const relative = value.slice("res://".length);
  if (relative.length === 0 || relative.startsWith("/") || relative.endsWith("/")) {
    return null;
  }
  const segments = relative.split("/");
  if (
    !segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !/[\u0000-\u001F\u007F]/u.test(segment),
    )
  ) {
    return null;
  }
  return segments;
};

/** Retained inventory identities follow the fixed inspector's prefix rule. */
const isInventoryMember = (value: string): boolean =>
  inventorySegments(value) !== null;

/** Generated destinations use the native safe-member rule. */
const isSafeDestinationMember = (value: string): boolean => {
  const segments = inventorySegments(value);
  if (segments === null) return false;
  return segments.every(
    (segment) =>
      !segment.endsWith(".") &&
      !segment.endsWith(" ") &&
      !segment.endsWith(":") &&
      !RESERVED_DEVICE_PATTERN.test(segment) &&
      !UNSAFE_SEGMENT_CHARS.test(segment),
  );
};

const requireMember = (
  value: unknown,
  label: string,
  predicate: (member: string) => boolean = isSafeDestinationMember,
): string => {
  if (typeof value !== "string" || !predicate(value)) {
    throw new CombinedReportError(`${label} is not a safe res:// logical member`);
  }
  return value;
};

const normalizeIdentity = (value: string): string => pathIdentity(value);

const samePath = (left: string, right: string): boolean =>
  normalizeIdentity(left) === normalizeIdentity(right);

const assertLocale = (value: string, label: string): string => {
  if (!isSafeTranslationLocale(value)) {
    throw new CombinedReportError(`${label} is not a safe exact locale identifier`);
  }
  return value;
};

const uniqueCaseFolded = (
  values: readonly string[],
  label: string,
): void => {
  const exact = new Set<string>();
  const folded = new Set<string>();
  for (const value of values) {
    if (exact.has(value)) {
      throw new CombinedReportError(`${label} repeats ${value}`);
    }
    const fold = value.toLowerCase();
    if (folded.has(fold)) {
      throw new CombinedReportError(`${label} collides case-insensitively: ${value}`);
    }
    exact.add(value);
    folded.add(fold);
  }
};

const sameStringSet = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  new Set(left).size === new Set(right).size &&
  [...new Set(left)].every((entry) => new Set(right).has(entry));

const addCounts = (target: Map<string, number>, values: readonly string[]): void => {
  for (const value of values) {
    target.set(value, (target.get(value) ?? 0) + 1);
  }
};

const includesMultiset = (
  expected: readonly string[],
  desired: readonly string[],
): boolean => {
  const available = new Map<string, number>();
  addCounts(available, expected);
  for (const value of desired) {
    const count = available.get(value) ?? 0;
    if (count === 0) return false;
    available.set(value, count - 1);
  }
  return true;
};

/**
 * Derive a new-locale member exactly as the native exporter does:
 * `path.get_basename().get_basename() + ".<locale>.translation"`.
 */
export const deriveNewLocaleMember = (
  defaultMember: string,
  locale: string,
): string => {
  const withoutExtension = defaultMember.replace(/\.[^./]*$/u, "");
  const withoutLocale = withoutExtension.replace(/\.[^./]*$/u, "");
  return `${withoutLocale}.${locale}.translation`;
};

const parseMapping = (value: unknown, label: string): CombinedMappingReport => {
  if (!isRecord(value)) throw new CombinedReportError(`${label} must be an object`);
  requireKeys(value, ["resource", "csv", "defaultLocale", "locales"], label);
  return {
    resource: requireMember(value.resource, `${label}.resource`),
    csv: requireString(value, "csv", label),
    defaultLocale: assertLocale(
      requireString(value, "defaultLocale", label),
      `${label}.defaultLocale`,
    ),
    locales: requireStringArray(value.locales, `${label}.locales`).map((locale) =>
      assertLocale(locale, `${label}.locales`),
    ),
  };
};

const parseExistingLocale = (
  value: unknown,
  label: string,
): CombinedExistingLocale => {
  if (!isRecord(value)) throw new CombinedReportError(`${label} must be an object`);
  requireKeys(value, ["locale", "member"], label);
  return {
    locale: assertLocale(requireString(value, "locale", label), `${label}.locale`),
    member: requireMember(value.member, `${label}.member`),
  };
};

const parseDesired = (
  value: unknown,
  label: string,
): Readonly<Record<string, string>> => {
  if (!isRecord(value)) throw new CombinedReportError(`${label} must be an object`);
  const desired = Object.create(null) as Record<string, string>;
  for (const [key, text] of Object.entries(value)) {
    if (key.length === 0 || typeof text !== "string") {
      throw new CombinedReportError(`${label} must map nonempty keys to strings`);
    }
    desired[key] = text;
  }
  return desired;
};

const parseOutput = (value: unknown, label: string): CombinedOutput => {
  if (!isRecord(value)) throw new CombinedReportError(`${label} must be an object`);
  requireKeys(
    value,
    ["resource", "member", "locale", "kind", "desired", "expectedValues"],
    label,
  );
  const kind = value.kind;
  if (kind !== "existing" && kind !== "new") {
    throw new CombinedReportError(`${label}.kind must be existing or new`);
  }
  return {
    resource: requireMember(value.resource, `${label}.resource`),
    member: requireMember(value.member, `${label}.member`),
    locale: assertLocale(requireString(value, "locale", label), `${label}.locale`),
    kind,
    desired: parseDesired(value.desired, `${label}.desired`),
    expectedValues: requireStringArray(
      value.expectedValues,
      `${label}.expectedValues`,
    ),
  };
};

const parseRetainedLocale = (
  value: unknown,
  label: string,
): CombinedRetainedLocale => {
  if (!isRecord(value)) throw new CombinedReportError(`${label} must be an object`);
  requireKeys(value, ["resource", "member", "locale", "expectedValues"], label);
  return {
    resource: requireMember(value.resource, `${label}.resource`),
    member: requireMember(value.member, `${label}.member`),
    locale: assertLocale(requireString(value, "locale", label), `${label}.locale`),
    expectedValues: requireStringArray(
      value.expectedValues,
      `${label}.expectedValues`,
    ),
  };
};

const parseProjectConfig = (
  value: unknown,
  label: string,
): CombinedProjectConfig | null => {
  if (value === null) return null;
  if (!isRecord(value)) throw new CombinedReportError(`${label} must be null or an object`);
  requireKeys(value, ["member", "registration"], label);
  const member = requireMember(value.member, `${label}.member`);
  if (
    member.toLowerCase() !== "res://project.godot" &&
    member.toLowerCase() !== "res://project.binary"
  ) {
    throw new CombinedReportError(
      `${label}.member is not a supported project configuration identity`,
    );
  }
  const registration = requireStringArray(
    value.registration,
    `${label}.registration`,
  ).map((entry, index) =>
    requireMember(entry, `${label}.registration[${String(index)}]`, isInventoryMember),
  );
  return { member, registration };
};

const parseVerifiedOutput = (
  value: unknown,
  label: string,
): CombinedVerifiedOutput => {
  if (!isRecord(value)) throw new CombinedReportError(`${label} must be an object`);
  requireKeys(
    value,
    [
      "resource",
      "member",
      "locale",
      "class",
      "verifiedTexts",
      "retainedContentVerified",
    ],
    label,
  );
  return {
    resource: requireMember(value.resource, `${label}.resource`),
    member: requireMember(value.member, `${label}.member`),
    locale: assertLocale(requireString(value, "locale", label), `${label}.locale`),
    class: requireString(value, "class", label),
    verifiedTexts: requireInteger(value, "verifiedTexts", label),
    retainedContentVerified: requireBoolean(
      value,
      "retainedContentVerified",
      label,
    ),
  };
};

const parseVerifiedRetained = (
  value: unknown,
  label: string,
): CombinedVerifiedRetainedLocale => {
  if (!isRecord(value)) throw new CombinedReportError(`${label} must be an object`);
  requireKeys(
    value,
    ["resource", "member", "locale", "retainedContentVerified"],
    label,
  );
  return {
    resource: requireMember(value.resource, `${label}.resource`),
    member: requireMember(value.member, `${label}.member`),
    locale: assertLocale(requireString(value, "locale", label), `${label}.locale`),
    retainedContentVerified: requireBoolean(
      value,
      "retainedContentVerified",
      label,
    ),
  };
};

const parseReportEnvelope = (
  value: unknown,
  label: string,
  extraKeys: readonly string[],
): Record<string, unknown> => {
  if (!isRecord(value)) throw new CombinedReportError(`${label} must be an object`);
  requireKeys(
    value,
    ["version", "ok", "stage", "error", "nativeCode", "userData", "temp", ...extraKeys],
    label,
  );
  if (value.version !== PCK_COMBINED_REPORT_VERSION) {
    throw new CombinedReportError(`${label}.version must be 1`);
  }
  requireBoolean(value, "ok", label);
  requireString(value, "stage", label);
  if (value.error !== null && typeof value.error !== "string") {
    throw new CombinedReportError(`${label}.error must be a string or null`);
  }
  requireInteger(value, "nativeCode", label);
  requireString(value, "userData", label);
  requireString(value, "temp", label);
  return value;
};

const assertOkReport = (
  report: {
    readonly ok: boolean;
    readonly stage: string;
    readonly error: string | null;
    readonly nativeCode: number;
  },
  label: string,
): void => {
  if (!report.ok) return;
  if (report.stage !== "complete") {
    throw new CombinedReportError(`${label} ok:true must have stage complete`);
  }
  if (report.error !== null) {
    throw new CombinedReportError(`${label} ok:true must not carry an error`);
  }
  if (report.nativeCode !== 0) {
    throw new CombinedReportError(`${label} ok:true must have nativeCode 0`);
  }
};

/** Build the fixed read-only preparation request. */
export const buildCombinedPreparationRequest = (
  expectation: CombinedPreparationExpectation,
): Record<string, unknown> => ({
  version: PCK_COMBINED_REPORT_VERSION,
  source: expectation.source,
  translations: [
    {
      resource: expectation.translation.resource,
      csv: expectation.translation.csv,
      columns: [...expectation.translation.columns],
      rows: expectation.translation.rows.map((row) => [...row]),
    },
  ],
  locales: [...expectation.locales],
  sourceMembers: [...expectation.sourceMembers],
  ordinaryMembers: [...expectation.ordinaryMembers],
});

const assertOwnedEnvironment = (
  report: { readonly userData: string; readonly temp: string },
  expectation: CombinedOwnedEnvironment,
): void => {
  if (!samePath(report.userData, expectation.userData)) {
    throw new CombinedReportError(
      "the combined native report userData directory is not the operation-owned profile",
    );
  }
  if (!expectation.temp.some((temp) => samePath(report.temp, temp))) {
    throw new CombinedReportError(
      "the combined native report temp directory is not the operation-owned profile",
    );
  }
};

const assertPrepareConsistency = (
  report: CombinedPrepareReport,
  expectation: CombinedPreparationExpectation,
): void => {
  if (!samePath(report.source, expectation.source)) {
    throw new CombinedReportError(
      "the combined preparation report describes a different source package",
    );
  }
  assertOwnedEnvironment(report, expectation.ownedEnvironment);
  if (report.mappings.length !== 1) {
    throw new CombinedReportError(
      "the combined preparation report must describe exactly one translation mapping",
    );
  }
  const mapping = report.mappings[0]!;
  if (mapping.resource !== expectation.translation.resource) {
    throw new CombinedReportError(
      "the combined preparation report mapping resource does not match the request",
    );
  }
  if (!samePath(mapping.csv, expectation.translation.csv)) {
    throw new CombinedReportError(
      "the combined preparation report mapping CSV does not match the operation-owned prepared copy",
    );
  }
  if (expectation.locales.length > 0) {
    if (
      mapping.locales.length !== expectation.locales.length ||
      mapping.locales.some(
        (locale, index) => locale !== expectation.locales[index],
      )
    ) {
      throw new CombinedReportError(
        "the combined preparation report selected locales do not match the explicit request",
      );
    }
  } else {
    const existingLocales = new Set(
      report.existingLocales.map((entry) => entry.locale),
    );
    const expectedSelection = expectation.translation.columns.filter(
      (column) => column !== "key" && !existingLocales.has(column),
    );
    if (
      expectedSelection.length === 0 ||
      mapping.locales.length !== expectedSelection.length ||
      mapping.locales.some(
        (locale, index) => locale !== expectedSelection[index],
      )
    ) {
      throw new CombinedReportError(
        "the combined preparation report omission selection must equal the CSV locale columns absent from the native existing locales",
      );
    }
  }

  uniqueCaseFolded(
    report.existingLocales.map((entry) => entry.locale),
    "combined preparation existing locales",
  );
  uniqueCaseFolded(
    report.existingLocales.map((entry) => entry.member),
    "combined preparation existing locale members",
  );
  const existingByLocale = new Map(
    report.existingLocales.map((entry) => [entry.locale, entry] as const),
  );
  if (!existingByLocale.has(mapping.defaultLocale)) {
    throw new CombinedReportError(
      "the combined preparation default locale is not an existing native locale",
    );
  }
  for (const entry of report.existingLocales) {
    if (!isInventoryMember(entry.member)) {
      throw new CombinedReportError(
        "the combined preparation existing locale member is not a safe inventory identity",
      );
    }
    if (!expectation.sourceMembers.includes(entry.member)) {
      throw new CombinedReportError(
        `the combined preparation existing locale member is absent from the source package: ${entry.member}`,
      );
    }
  }

  if (report.outputs.length === 0) {
    throw new CombinedReportError(
      "the combined preparation report selected no translation output",
    );
  }
  uniqueCaseFolded(
    report.outputs.map((entry) => entry.member),
    "combined preparation output members",
  );
  uniqueCaseFolded(
    report.outputs.map((entry) => entry.locale),
    "combined preparation output locales",
  );
  const selectedByOutput = report.outputs.map((entry) => entry.locale);
  if (!sameStringSet(selectedByOutput, mapping.locales)) {
    throw new CombinedReportError(
      "the combined preparation output locales do not match the selected mapping locales",
    );
  }
  const { columns, rows } = expectation.translation;
  const keyIndex = columns.indexOf("key");
  if (keyIndex < 0) {
    throw new CombinedReportError(
      "the prepared CSV has no key column for combined preparation",
    );
  }
  for (const [rowIndex, row] of rows.entries()) {
    if (row.length !== columns.length) {
      throw new CombinedReportError(
        `prepared CSV row ${String(rowIndex + 1)} does not match the declared width`,
      );
    }
  }
  const desiredByLocale = new Map<string, Readonly<Record<string, string>>>();
  for (const output of report.outputs) {
    const columnIndex = columns.indexOf(output.locale);
    if (columnIndex < 0) {
      throw new CombinedReportError(
        "a combined output locale is absent from the prepared CSV columns",
      );
    }
    const desired = Object.create(null) as Record<string, string>;
    for (const row of rows) {
      desired[row[keyIndex]!] = row[columnIndex]!;
    }
    desiredByLocale.set(output.locale, desired);
  }
  const sourceMemberSet = new Set(expectation.sourceMembers);
  const ordinaryFolded = new Set(
    expectation.ordinaryMembers.map((member) => member.toLowerCase()),
  );
  for (const output of report.outputs) {
    if (output.resource !== mapping.resource) {
      throw new CombinedReportError(
        "a combined preparation output resource does not match the mapping",
      );
    }
    if (ordinaryFolded.has(output.member.toLowerCase())) {
      throw new CombinedReportError(
        "a combined preparation output collides with an ordinary replacement target",
      );
    }
    const expectedDesired = desiredByLocale.get(output.locale);
    if (
      expectedDesired === undefined ||
      !sameStringSet(Object.keys(output.desired), Object.keys(expectedDesired)) ||
      Object.entries(expectedDesired).some(
        ([key, value]) => output.desired[key] !== value,
      )
    ) {
      throw new CombinedReportError(
        `the combined preparation desired text for ${output.locale} does not match the prepared CSV`,
      );
    }
    if (
      output.expectedValues.length < Object.keys(output.desired).length ||
      !includesMultiset(output.expectedValues, Object.values(output.desired))
    ) {
      throw new CombinedReportError(
        `the combined preparation expected values for ${output.locale} do not include the requested replacement text`,
      );
    }
    const existing = existingByLocale.get(output.locale);
    if (output.kind === "existing") {
      if (existing === undefined) {
        throw new CombinedReportError(
          `an existing combined output locale is not an existing native locale: ${output.locale}`,
        );
      }
      if (output.member !== existing.member) {
        throw new CombinedReportError(
          `an existing combined output member does not match the native locale resource: ${output.locale}`,
        );
      }
      if (!sourceMemberSet.has(output.member)) {
        throw new CombinedReportError(
          `an existing combined output member is absent from the source package: ${output.member}`,
        );
      }
    } else {
      if (existing !== undefined) {
        throw new CombinedReportError(
          `a new combined output locale is already an existing native locale: ${output.locale}`,
        );
      }
      if (sourceMemberSet.has(output.member)) {
        throw new CombinedReportError(
          `a new combined output member is already present in the source package: ${output.member}`,
        );
      }
      const defaultMember = existingByLocale.get(mapping.defaultLocale)!.member;
      if (output.member !== deriveNewLocaleMember(defaultMember, output.locale)) {
        throw new CombinedReportError(
          `a new combined output member is not the native-derived destination: ${output.locale}`,
        );
      }
    }
  }

  const outputLocales = new Set(selectedByOutput);
  const expectedRetained = report.existingLocales.filter(
    (entry) => !outputLocales.has(entry.locale),
  );
  if (
    report.retainedLocales.length !== expectedRetained.length ||
    report.retainedLocales.some(
      (entry) =>
        !expectedRetained.some(
          (expected) =>
            expected.locale === entry.locale && expected.member === entry.member,
        ),
    )
  ) {
    throw new CombinedReportError(
      "the combined retained locales do not match the unselected existing locales",
    );
  }
  uniqueCaseFolded(
    report.retainedLocales.map((entry) => entry.member),
    "combined retained locale members",
  );
  for (const entry of report.retainedLocales) {
    if (entry.resource !== mapping.resource) {
      throw new CombinedReportError(
        "a combined retained locale resource does not match the mapping",
      );
    }
    if (ordinaryFolded.has(entry.member.toLowerCase())) {
      throw new CombinedReportError(
        "a combined retained locale collides with an ordinary replacement target",
      );
    }
  }
  if (
    report.outputs.length + report.retainedLocales.length !==
    report.existingLocales.length + report.outputs.filter((entry) => entry.kind === "new").length
  ) {
    throw new CombinedReportError(
      "the combined selected, retained and existing locale counts are inconsistent",
    );
  }

  if (report.projectConfig !== null) {
    const config = report.projectConfig;
    if (ordinaryFolded.has(config.member.toLowerCase())) {
      throw new CombinedReportError(
        "the project configuration member collides with an ordinary replacement target",
      );
    }
    if (config.member.toLowerCase() === mapping.resource.toLowerCase()) {
      throw new CombinedReportError(
        "the project configuration member must not be the translation import source",
      );
    }
    if (new Set(config.registration).size !== config.registration.length) {
      throw new CombinedReportError(
        "the combined project configuration registration repeats an entry",
      );
    }
    if (
      config.registration.some(
        (entry) => entry.toLowerCase() === config.member.toLowerCase(),
      )
    ) {
      throw new CombinedReportError(
        "the combined project configuration registration contains a self-entry",
      );
    }
    for (const output of report.outputs) {
      if (!config.registration.includes(output.member)) {
        throw new CombinedReportError(
          `the combined project configuration registration omits an output member: ${output.member}`,
        );
      }
    }
    const sorted = [...config.registration].sort();
    if (sorted.some((entry, index) => entry !== config.registration[index])) {
      throw new CombinedReportError(
        "the combined project configuration registration is not sorted",
      );
    }
  }
};

/** Parse and accept one preparation report. Consistency applies only to ok:true. */
export const acceptCombinedPrepareReport = (
  value: unknown,
  expectation: CombinedPreparationExpectation,
): CombinedPrepareReport => {
  const label = "combined preparation report";
  const envelope = parseReportEnvelope(value, label, [
    "source",
    "mappings",
    "existingLocales",
    "outputs",
    "retainedLocales",
    "projectConfig",
  ]);
  const report: CombinedPrepareReport = {
    version: 1,
    ok: envelope.ok as boolean,
    stage: envelope.stage as string,
    error: envelope.error as string | null,
    nativeCode: envelope.nativeCode as number,
    source: requireString(envelope, "source", label),
    userData: requireString(envelope, "userData", label),
    temp: requireString(envelope, "temp", label),
    mappings: requireArray(envelope, "mappings", label).map((entry, index) =>
      parseMapping(entry, `${label}.mappings[${String(index)}]`),
    ),
    existingLocales: requireArray(envelope, "existingLocales", label).map(
      (entry, index) =>
        parseExistingLocale(entry, `${label}.existingLocales[${String(index)}]`),
    ),
    outputs: requireArray(envelope, "outputs", label).map((entry, index) =>
      parseOutput(entry, `${label}.outputs[${String(index)}]`),
    ),
    retainedLocales: requireArray(envelope, "retainedLocales", label).map(
      (entry, index) =>
        parseRetainedLocale(
          entry,
          `${label}.retainedLocales[${String(index)}]`,
        ),
    ),
    projectConfig: parseProjectConfig(
      envelope.projectConfig,
      `${label}.projectConfig`,
    ),
  };
  assertOkReport(report, label);
  if (report.ok) assertPrepareConsistency(report, expectation);
  return report;
};

/** Build the fixed read-only verification request from an accepted report. */
export const buildCombinedVerificationRequest = (
  packagePath: string,
  report: CombinedPrepareReport,
): Record<string, unknown> => ({
  version: PCK_COMBINED_REPORT_VERSION,
  package: packagePath,
  translations: report.outputs.map((output) => ({
    resource: output.resource,
    member: output.member,
    locale: output.locale,
    desired: { ...output.desired },
    expectedValues: [...output.expectedValues],
  })),
  retainedLocales: report.retainedLocales.map((entry) => ({
    resource: entry.resource,
    member: entry.member,
    locale: entry.locale,
    expectedValues: [...entry.expectedValues],
  })),
  projectConfig:
    report.projectConfig === null
      ? null
      : {
          member: report.projectConfig.member,
          registration: [...report.projectConfig.registration],
        },
});

const assertVerificationConsistency = (
  report: CombinedVerificationReport,
  expectation: CombinedVerificationExpectation,
): void => {
  if (!samePath(report.package, expectation.package)) {
    throw new CombinedReportError(
      "the combined verification report describes a different output package",
    );
  }
  assertOwnedEnvironment(report, expectation.ownedEnvironment);
  if (report.outputs.length !== expectation.outputs.length) {
    throw new CombinedReportError(
      "the combined verification report output count does not match the accepted preparation",
    );
  }
  uniqueCaseFolded(
    report.outputs.map((entry) => entry.member),
    "combined verification output members",
  );
  for (const expected of expectation.outputs) {
    const actual = report.outputs.find(
      (entry) =>
        entry.member === expected.member &&
        entry.resource === expected.resource &&
        entry.locale === expected.locale,
    );
    if (actual === undefined) {
      throw new CombinedReportError(
        `the combined verification report omits an expected output: ${expected.member}`,
      );
    }
    if (actual.class !== "OptimizedTranslation") {
      throw new CombinedReportError(
        `the combined verification output class is not OptimizedTranslation: ${expected.member}`,
      );
    }
    if (actual.verifiedTexts !== Object.keys(expected.desired).length) {
      throw new CombinedReportError(
        `the combined verification text count does not match the desired keys: ${expected.member}`,
      );
    }
    if (!actual.retainedContentVerified) {
      throw new CombinedReportError(
        `the combined verification did not retain the expected content: ${expected.member}`,
      );
    }
  }
  if (report.retainedLocales.length !== expectation.retainedLocales.length) {
    throw new CombinedReportError(
      "the combined verification retained-locale count does not match the accepted preparation",
    );
  }
  uniqueCaseFolded(
    report.retainedLocales.map((entry) => entry.member),
    "combined verification retained locale members",
  );
  for (const expected of expectation.retainedLocales) {
    const actual = report.retainedLocales.find(
      (entry) =>
        entry.member === expected.member &&
        entry.resource === expected.resource &&
        entry.locale === expected.locale,
    );
    if (actual === undefined) {
      throw new CombinedReportError(
        `the combined verification report omits a retained locale: ${expected.member}`,
      );
    }
    if (!actual.retainedContentVerified) {
      throw new CombinedReportError(
        `the combined verification did not retain the expected locale content: ${expected.member}`,
      );
    }
  }
  if (expectation.projectConfig === null) {
    if (report.projectConfig !== null) {
      throw new CombinedReportError(
        "the combined verification reported a project configuration that was expected to be absent",
      );
    }
  } else {
    if (report.projectConfig === null) {
      throw new CombinedReportError(
        "the combined verification did not report the expected project configuration",
      );
    }
    if (report.projectConfig.member !== expectation.projectConfig.member) {
      throw new CombinedReportError(
        "the combined verification project configuration identity does not match",
      );
    }
    if (
      !sameStringSet(
        report.projectConfig.registration,
        expectation.projectConfig.registration,
      )
    ) {
      throw new CombinedReportError(
        "the combined verification project configuration registration does not match",
      );
    }
    if (new Set(report.projectConfig.registration).size !== report.projectConfig.registration.length) {
      throw new CombinedReportError(
        "the combined verification project configuration registration repeats an entry",
      );
    }
  }
};

/** Parse and accept one verification report. Consistency applies only to ok:true. */
export const acceptCombinedVerificationReport = (
  value: unknown,
  expectation: CombinedVerificationExpectation,
): CombinedVerificationReport => {
  const label = "combined verification report";
  const envelope = parseReportEnvelope(value, label, [
    "package",
    "outputs",
    "retainedLocales",
    "projectConfig",
  ]);
  const report: CombinedVerificationReport = {
    version: 1,
    ok: envelope.ok as boolean,
    stage: envelope.stage as string,
    error: envelope.error as string | null,
    nativeCode: envelope.nativeCode as number,
    package: requireString(envelope, "package", label),
    userData: requireString(envelope, "userData", label),
    temp: requireString(envelope, "temp", label),
    outputs: requireArray(envelope, "outputs", label).map((entry, index) =>
      parseVerifiedOutput(entry, `${label}.outputs[${String(index)}]`),
    ),
    retainedLocales: requireArray(envelope, "retainedLocales", label).map(
      (entry, index) =>
        parseVerifiedRetained(
          entry,
          `${label}.retainedLocales[${String(index)}]`,
        ),
    ),
    projectConfig: parseProjectConfig(
      envelope.projectConfig,
      `${label}.projectConfig`,
    ),
  };
  assertOkReport(report, label);
  if (report.ok) assertVerificationConsistency(report, expectation);
  return report;
};
