import { readFile, unlink, writeFile } from "node:fs/promises";
import {
  collectVersionTokens,
  findVersionTokens,
  renderMigrationCostReport,
} from "../eng/estimate_migration_cost.mjs";

const PASS = "PASS";
const FAIL = "FAIL";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export async function runMigrationCostTests() {
  let passed = 0;
  let failed = 0;

  async function runTest(name, fn) {
    try {
      await fn();
      passed += 1;
      console.log(`${PASS} ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`${FAIL} ${name}: ${error.message}`);
    }
  }

  await runTest("extractor records every query-version token and source location", () => {
    const marker = `?${"v="}`;
    const source = `import one from "./one.js${marker}alpha";\nimport two from "./two.js${marker}beta";`;
    const occurrences = findVersionTokens(source, "fixture.js");
    assert(occurrences.length === 2, "both tokens are discovered");
    assert(occurrences[0].token === `${marker}alpha`, "the first token is preserved");
    assert(occurrences[0].line === 1 && occurrences[1].line === 2, "line locations are recorded");
    assert(occurrences.every((occurrence) => occurrence.column > 0), "column locations are one-based");
  });

  await runTest("generated migration report matches the current repository inventory", async () => {
    const occurrences = await collectVersionTokens();
    const report = await readFile(new URL("../docs/migration_cost.md", import.meta.url), "utf8");
    assert(occurrences.length > 0, "repository query-version tokens are discovered");
    assert(
      report.replaceAll("\r\n", "\n") === renderMigrationCostReport(occurrences),
      "generated report is current and deterministic"
    );
    assert(occurrences.every((occurrence) => occurrence.filePath && occurrence.line > 0), "every token has a file and line");
  });

  await runTest("untracked local files cannot change the migration inventory", async () => {
    const probeUrl = new URL("../migration-cost-untracked-probe.md", import.meta.url);
    const marker = `?${"v="}`;
    await writeFile(probeUrl, `untracked ${marker}must-not-count\n`, "utf8");
    try {
      const occurrences = await collectVersionTokens();
      assert(
        !occurrences.some((occurrence) => occurrence.filePath === "migration-cost-untracked-probe.md"),
        "untracked files are excluded"
      );
    } finally {
      await unlink(probeUrl);
    }
  });

  console.log(`Results: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}
