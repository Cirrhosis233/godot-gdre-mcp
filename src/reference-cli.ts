import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateCommandReference } from "./reference.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const referencePath = resolve(projectRoot, "docs", "command-reference.md");

const usage = "Usage: node dist/src/reference-cli.js <write|check>";

const main = (): void => {
  const command = process.argv[2];
  if (command !== "write" && command !== "check") {
    process.stderr.write(`${usage}\n`);
    process.exitCode = 2;
    return;
  }

  const generated = generateCommandReference();
  if (command === "write") {
    mkdirSync(dirname(referencePath), { recursive: true });
    writeFileSync(referencePath, generated, "utf8");
    process.stdout.write(`Wrote ${referencePath}\n`);
    return;
  }

  let tracked: string;
  try {
    tracked = readFileSync(referencePath, "utf8");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Reference check failed: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  if (tracked !== generated) {
    process.stderr.write(
      `Reference is stale: ${referencePath}. Run npm run reference:generate.\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Reference is fresh: ${referencePath}\n`);
};

main();
