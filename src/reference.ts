import { commandRegistry } from "./registry.js";
import type {
  AnyCommandDescriptor,
  AnyParameterDescriptor,
  CommandRegistry,
} from "./types.js";

const quote = (value: string): string => `\`${value.replaceAll("`", "\\`")}\``;

const list = (values: readonly string[]): string =>
  values.length === 0 ? "None" : values.map(quote).join(", ");

const tableCell = (value: string): string =>
  value.replaceAll("|", "\\|").replaceAll("\n", " ");

const parameterRow = (parameter: AnyParameterDescriptor): string =>
  `| ${tableCell(parameter.name)} | ${tableCell(parameter.type)} | ${
    parameter.required ? "yes" : "no"
  } | ${tableCell(parameter.description)} | ${tableCell(parameter.encoding)} |`;

const renderParameterTable = (
  parameters: readonly AnyParameterDescriptor[],
): string[] => {
  if (parameters.length === 0) {
    return ["No command-specific parameters."];
  }

  return [
    "| Parameter | Type | Required | Description | Encoding |",
    "| --- | --- | --- | --- | --- |",
    ...parameters.map(parameterRow),
  ];
};

const invocationDescription = (command: AnyCommandDescriptor): string =>
  command.id === "patch-translations"
    ? `Fixed native composition: ${quote(JSON.stringify(command.argv))} followed by the adapter-owned script, ${quote("--")}, operation-owned request/report paths, and an optional redacted key token. Inputs, translation mappings and ordered session actions are carried by the prepared request, not caller-controlled argv.`
    : command.routing === "application"
      ? `Application argv prefix: ${quote(JSON.stringify(command.argv))}; append ordered session actions, repeated mapped primary arguments, and applicable ordinary fields as described by the parameter contract.`
      : `Exact argv: ${quote(JSON.stringify(command.argv))}`;

const invocationTableCell = (command: AnyCommandDescriptor): string =>
  command.routing === "application"
    ? `prefix ${JSON.stringify(command.argv)} + mapped arguments`
    : JSON.stringify(command.argv);

const evidenceSource = (source: string): string =>
  source.startsWith("https://")
    ? `[${source}](${source})`
    : source.replace(
        /(?:src|test|native|docs)\/[\w./-]+\.(?:ts|md|gd|ps1|cs)\b/gu,
        (file) => `[${file}](../${file})`,
      );

const renderCoverageList = (heading: string, values: readonly string[]): string[] => [
  `##### ${heading}`,
  "",
  ...(values.length === 0 ? ["None."] : values.map((value) => `- ${value}`)),
  "",
];

const renderCommand = (command: AnyCommandDescriptor): string[] => [
  `### ${command.toolName}`,
  "",
  command.description,
  "",
  `- Canonical ID: ${quote(command.id)}`,
  `- Category: ${quote(command.category)}`,
  `- Routing: ${quote(command.routing)}`,
  `- CLI spellings: ${list(command.cliSpellings)}`,
  `- ${invocationDescription(command)}`,
  `- MCP annotations: read-only=${String(command.annotations.readOnlyHint)}, destructive=${String(
    command.annotations.destructiveHint,
  )}, idempotent=${String(command.annotations.idempotentHint)}, open-world=${String(
    command.annotations.openWorldHint,
  )}`,
  "",
  "#### Parameters",
  "",
  ...renderParameterTable(command.parameterDescriptors),
  "",
  "#### Declared effects",
  "",
  `- Reads: ${list(command.effects.reads)}`,
  `- Writes: ${list(command.effects.writes)}`,
  `- Network: ${String(command.effects.network)}`,
  `- Code execution: ${String(command.effects.codeExecution)}`,
  `- Unknown scope: ${String(command.effects.unknownScope)}`,
  "",
  "<details>",
  "<summary>Evidence and coverage</summary>",
  "",
  ...command.evidence.map(
    (evidence) =>
      `- [${evidence.status}] ${evidenceSource(evidence.source)} — ${evidence.detail}`,
  ),
  "",
  `Fixture IDs: ${list(command.coverage.fixtureIds)}`,
  "",
  ...renderCoverageList("Constraints", command.coverage.constraints),
  ...renderCoverageList("Prerequisites", command.coverage.prerequisites),
  "</details>",
  "",
];

/** Generate the tracked command reference from the authoritative registry. */
export function generateCommandReference(
  commands: readonly AnyCommandDescriptor[] = commandRegistry,
): string {
  const lines = [
    "# GDRE Command Reference",
    "",
    "This file is generated from the typed command registry. Do not edit it by hand.",
    "See [tool usage](tool-usage.md) for examples and [development](development.md) for regeneration commands.",
    "",
    "Expandable evidence sections use **S** for inspected source, **R+** for successful runtime fixtures, **R-** for observed failures/prerequisites, and **U** for unexecuted behavior. Fixture coverage does not imply support for every upstream format or option.",
    "",
    `Registry entries: ${String(commands.length)}`,
    "",
    "## Registered tools",
    "",
    "| ID | Tool | Category | CLI spelling | Invocation argv |",
    "| --- | --- | --- | --- | --- |",
    ...commands.map(
      (command) =>
        `| ${quote(command.id)} | [${quote(command.toolName)}](#${command.toolName}) | ${quote(
          command.category,
        )} | ${list(command.cliSpellings)} | ${quote(invocationTableCell(command))} |`,
    ),
    "",
    ...commands.flatMap(renderCommand),
    "",
  ];

  return `${lines.join("\n").replace(/\n{3,}/gu, "\n\n").trimEnd()}\n`;
}

/** Short alias used by scripts and downstream registry consumers. */
export const generateReference = generateCommandReference;
export const renderCommandReference = generateCommandReference;

export type { CommandRegistry };
