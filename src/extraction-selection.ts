/**
 * Ticket 22 extraction selection semantics.
 *
 * Pure derivation of the expected selected member set from the complete res://
 * member list. Includes use a filesystem-style glob (`*`/`?` do not cross `/`,
 * `**` matches zero or more segments); excludes use an anchored whole-string
 * wildcard where `*` crosses `/`. The asymmetry mirrors the fixed runtime and
 * is intentional. Patterns are case-sensitive; selection modes compare
 * extensions case-insensitively. Matching is bounded (no regex, no exponential
 * backtracking) and honors an optional abort signal and monotonic deadline.
 */

export type ExtractionSelectionMode = "all" | "scripts" | "translations";
export type ExtractionSourceKind = "package" | "directory";

export interface ExtractionSelectionRequest {
  readonly mode: ExtractionSelectionMode;
  /** Ordered include patterns, preserving caller spelling and order. */
  readonly include: readonly string[];
  /** Ordered exclude patterns, preserving caller spelling and order. */
  readonly exclude: readonly string[];
}

export interface ExtractionSelectionOptions {
  /** Optional abort signal; derivation throws if aborted. */
  readonly signal?: AbortSignal;
  /** Optional monotonic deadline (`performance.now()` base); derivation throws once exceeded. */
  readonly deadlineMono?: number;
}

export type ExtractionSelectionOutcome =
  | {
      readonly ok: true;
      readonly expectedMembers: readonly string[];
      readonly classification: "selected" | "no_match";
    }
  | {
      readonly ok: false;
      readonly reason: "directory_filter_unsupported";
      readonly message: string;
      readonly patterns: readonly string[];
    };

const SCRIPT_EXTENSIONS = new Set(["gd", "gdc", "gde"]);
const TRANSLATION_EXTENSIONS = new Set(["translation", "xl"]);
const LOGICAL_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)(.*)$/u;

const extensionOf = (member: string): string => {
  const slash = member.lastIndexOf("/");
  const dot = member.lastIndexOf(".");
  return dot <= slash ? "" : member.slice(dot + 1).toLowerCase();
};

/** Bare-star form: has `*`, no path separator, and no `**` segment. */
export const isBareStarFilter = (pattern: string): boolean => {
  const normalized = pattern.replaceAll("\\", "/");
  return normalized.includes("*") && !normalized.includes("/") && !normalized.includes("**");
};

const splitLogical = (value: string): { readonly scheme: string; readonly segments: readonly string[] } => {
  const match = LOGICAL_SCHEME.exec(value);
  return {
    scheme: match?.[1] ?? "",
    segments: (match?.[2] ?? value).split("/").filter((segment) => segment.length > 0),
  };
};

const simplifyLogical = (value: string): string => {
  const { scheme, segments } = splitLogical(value);
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === ".") continue;
    if (segment === "..") {
      const previous = resolved[resolved.length - 1];
      if (previous !== undefined && previous !== "..") resolved.pop();
      else resolved.push("..");
      continue;
    }
    resolved.push(segment);
  }
  return `${scheme}${resolved.join("/")}`;
};

/** Mirrors GDRE `normalize_cludes` for the res:// logical root. */
export const normalizeSelectionPattern = (pattern: string): string => {
  const slashed = pattern.replaceAll("\\", "/");
  if (!slashed.includes("**") && slashed.includes("*") && !slashed.includes("/")) {
    return simplifyLogical(`res://**/${slashed}`);
  }
  const rooted = slashed.startsWith("/") ? slashed.slice(1) : slashed;
  return simplifyLogical(LOGICAL_SCHEME.test(rooted) ? rooted : `res://${rooted}`);
};

/** Code-point array so `?` and literals follow the runtime's one-code-point units. */
const codePoints = (value: string): readonly string[] => Array.from(value);

/**
 * Bounded wildcard match (O(text * pattern)): `*` matches any run, `?` exactly
 * one code point, other characters are literal. Used whole-string for excludes
 * (so `*` crosses `/`) and per-segment for includes (no `/` within a segment).
 * `budget` is checked periodically so a long name cannot overrun a short
 * deadline before the outer member check.
 */
const wildcardMatch = (
  text: readonly string[],
  pattern: readonly string[],
  budget: () => void,
): boolean => {
  let ti = 0;
  let pi = 0;
  let star = -1;
  let mark = 0;
  let steps = 0;
  const tick = (): void => {
    steps += 1;
    if ((steps & 0xff) === 0) budget();
  };
  while (ti < text.length) {
    tick();
    if (pi < pattern.length && (pattern[pi] === "?" || pattern[pi] === text[ti])) {
      ti += 1;
      pi += 1;
    } else if (pi < pattern.length && pattern[pi] === "*") {
      star = pi;
      mark = ti;
      pi += 1;
    } else if (star !== -1) {
      pi = star + 1;
      mark += 1;
      ti = mark;
    } else {
      return false;
    }
  }
  while (pi < pattern.length && pattern[pi] === "*") pi += 1;
  return pi === pattern.length;
};

/** Greedy segment match with `**` over zero or more segments (bounded, no recursion). */
const matchSegments = (
  patternSegs: readonly string[],
  memberSegs: readonly string[],
  budget: () => void,
): boolean => {
  let pi = 0;
  let si = 0;
  let starPi = -1;
  let starSi = 0;
  while (si < memberSegs.length) {
    budget();
    const token = patternSegs[pi];
    if (pi < patternSegs.length && token !== "**" && wildcardMatch(codePoints(memberSegs[si]!), codePoints(token!), budget)) {
      pi += 1;
      si += 1;
    } else if (pi < patternSegs.length && token === "**") {
      starPi = pi;
      starSi = si;
      pi += 1;
    } else if (starPi !== -1) {
      pi = starPi + 1;
      starSi += 1;
      si = starSi;
    } else {
      return false;
    }
  }
  while (pi < patternSegs.length && patternSegs[pi] === "**") pi += 1;
  return pi === patternSegs.length;
};

const includeMatches = (
  member: string,
  normalizedPattern: string,
  budget: () => void,
): boolean => {
  const memberParts = splitLogical(member);
  const patternParts = splitLogical(normalizedPattern);
  return (
    memberParts.scheme === patternParts.scheme &&
    matchSegments(patternParts.segments, memberParts.segments, budget)
  );
};

/** Excludes are anchored whole-string matches where `*` crosses `/`. */
const excludeMatches = (
  member: string,
  normalizedPattern: string,
  budget: () => void,
): boolean => wildcardMatch(codePoints(member), codePoints(normalizedPattern), budget);

/**
 * Derive the expected selected member set for a validated selection request.
 *
 * `members` is the complete, ordered list of res:// logical member names.
 * `sourceKind` distinguishes package inputs (full normalization) from marked
 * directory inputs, where only bare-star filters are admitted because the
 * measured runtime rewrites rooted/relative directory patterns to real paths
 * that cannot fulfill a selected subset.
 */
export const deriveSelectedMembers = (
  request: ExtractionSelectionRequest,
  members: readonly string[],
  sourceKind: ExtractionSourceKind,
  options: ExtractionSelectionOptions = {},
): ExtractionSelectionOutcome => {
  const { signal, deadlineMono } = options;
  const checkBudget = (): void => {
    if (signal?.aborted === true) throw new Error("selection derivation aborted");
    if (deadlineMono !== undefined && performance.now() > deadlineMono) {
      throw new Error("selection derivation deadline exceeded");
    }
  };

  checkBudget();
  const hasFilters = request.include.length > 0 || request.exclude.length > 0;
  if (request.mode !== "all" && hasFilters) {
    throw new Error("selection mode cannot be combined with include or exclude filters");
  }

  if (sourceKind === "directory") {
    const rejected = [...request.include, ...request.exclude].filter((pattern) => !isBareStarFilter(pattern));
    if (rejected.length > 0) {
      return {
        ok: false,
        reason: "directory_filter_unsupported",
        message:
          "directory inputs accept only bare-star filter patterns (a * wildcard, no path separator, and no ** segment)",
        patterns: rejected,
      };
    }
  }

  let candidates: readonly string[];
  if (request.mode !== "all") {
    const extensions = request.mode === "scripts" ? SCRIPT_EXTENSIONS : TRANSLATION_EXTENSIONS;
    const matched: string[] = [];
    for (const member of members) {
      checkBudget();
      if (extensions.has(extensionOf(member))) matched.push(member);
    }
    candidates = matched;
  } else if (request.include.length > 0) {
    const patterns = request.include.map(normalizeSelectionPattern);
    const included: string[] = [];
    for (const member of members) {
      checkBudget();
      checkBudget();
      if (patterns.some((pattern) => { checkBudget(); return includeMatches(member, pattern, checkBudget); })) included.push(member);
    }
    candidates = included;
  } else {
    candidates = members;
  }

  const excludePatterns = request.exclude.map(normalizeSelectionPattern);
  const remaining: string[] = [];
  for (const member of candidates) {
    checkBudget();
    if (!excludePatterns.some((pattern) => { checkBudget(); return excludeMatches(member, pattern, checkBudget); })) remaining.push(member);
  }

  const seen = new Set<string>();
  const expectedMembers: string[] = [];
  for (const member of remaining) {
    checkBudget();
    if (!seen.has(member)) {
      seen.add(member);
      expectedMembers.push(member);
    }
  }

  return {
    ok: true,
    expectedMembers,
    classification: expectedMembers.length > 0 ? "selected" : "no_match",
  };
};
