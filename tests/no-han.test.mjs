import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const textExtensions = new Set([".css", ".html", ".js", ".json", ".md", ".mjs"]);
const ignoredDirectories = new Set([".git", "node_modules"]);

async function collectTextFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectTextFiles(path));
    else if (textExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

test("Han characters stay inside Chinese locale and documentation files", async () => {
  const violations = [];
  for (const file of await collectTextFiles(root)) {
    const repositoryPath = relative(root, file);
    if (repositoryPath === "README.zh-CN.md" || repositoryPath.startsWith("_locales/zh_")) continue;
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (/\p{Script=Han}/u.test(line)) {
        violations.push(`${repositoryPath}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(violations, [], "Han characters must stay inside Chinese locale and documentation files");
});
