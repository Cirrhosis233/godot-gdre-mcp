/** Bound a diagnostic string by UTF-8 bytes without splitting a character. */
export const boundedUtf8 = (value: unknown, fallback = "error", maxBytes = 2_048): string => {
  const text = value instanceof Error ? value.message : String(value ?? fallback);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffix = "...";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  let result = "";
  let bytes = 0;
  for (const character of text) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next + suffixBytes > maxBytes) break;
    result += character;
    bytes += next;
  }
  return `${result}${suffix}`;
};
