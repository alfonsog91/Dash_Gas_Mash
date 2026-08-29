import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { format } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testsRoot = join(repositoryRoot, "tests");
const baselinePath = join(repositoryRoot, "eng", "baseline.json");

async function discoverTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await discoverTestFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      files.push(entryPath);
    }
  }

  return files;
}

function readPassBaseline(value) {
  if (!Number.isInteger(value?.passCount) || value.passCount < 0) {
    throw new Error("eng/baseline.json must contain a non-negative integer passCount");
  }
  return value.passCount;
}

function errorMessage(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const baselinePassCount = readPassBaseline(baseline);
let passCount = 0;
let failCount = 0;

const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

function countResultLines(args) {
  for (const line of format(...args).split(/\r?\n/)) {
    if (line.startsWith("PASS ")) {
      passCount += 1;
    } else if (line.startsWith("FAIL ")) {
      failCount += 1;
    }
  }
}

for (const methodName of Object.keys(originalConsole)) {
  console[methodName] = (...args) => {
    countResultLines(args);
    originalConsole[methodName](...args);
  };
}

const runners = [];

try {
  for (const testFile of await discoverTestFiles(testsRoot)) {
    let testModule;
    try {
      testModule = await import(pathToFileURL(testFile).href);
    } catch (error) {
      console.error(`FAIL import ${relative(repositoryRoot, testFile)}: ${errorMessage(error)}`);
      continue;
    }

    for (const [exportName, exportedValue] of Object.entries(testModule)) {
      if (/^run.*Tests$/.test(exportName) && typeof exportedValue === "function") {
        runners.push({ exportName, runner: exportedValue });
      }
    }
  }

  for (const { exportName, runner } of runners) {
    const failuresBeforeRunner = failCount;
    try {
      const result = await runner();
      if (Number(result?.failed) > 0 && failCount === failuresBeforeRunner) {
        console.error(`FAIL ${exportName}: runner reported ${result.failed} failed test(s)`);
      }
    } catch (error) {
      console.error(`FAIL ${exportName}: ${errorMessage(error)}`);
    }
  }
} finally {
  Object.assign(console, originalConsole);
}

originalConsole.log("");
originalConsole.log(`Test summary: PASS ${passCount}, FAIL ${failCount}`);
originalConsole.log(`Recorded baseline: PASS ${baselinePassCount}`);

if (failCount > 0 || passCount < baselinePassCount) {
  if (passCount < baselinePassCount) {
    originalConsole.error(`PASS count is below baseline: ${passCount} < ${baselinePassCount}`);
  }
  process.exitCode = 1;
}
