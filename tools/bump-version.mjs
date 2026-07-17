#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const TARGETS = [
  "package.json",
  "packages/chain/package.json",
  "packages/core/package.json",
  "packages/crypto/package.json",
  "packages/encryption/package.json",
  "packages/payment/package.json",
  "packages/storage/package.json",
];

function parseVersion(version, filePath) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(
      `[dStorage] ${filePath}: version "${version}" is not a plain MAJOR.MINOR.PATCH semver string`,
    );
  }
  const [, major, minor, patch] = match;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

function bump({ major, minor, patch }, bumpType) {
  if (bumpType === "minor") {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

const bumpType = process.argv.includes("--minor") ? "minor" : "patch";

const rootPackagePath = path.join(rootDir, TARGETS[0]);
const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"));
const rootVersion = rootPackage.version;
const newVersion = bump(parseVersion(rootVersion, TARGETS[0]), bumpType);

const updates = [];

for (const relativePath of TARGETS) {
  const filePath = path.join(rootDir, relativePath);
  const contents = JSON.parse(readFileSync(filePath, "utf8"));
  const oldVersion = contents.version;

  if (oldVersion !== rootVersion) {
    throw new Error(
      `[dStorage] ${relativePath}: version "${oldVersion}" does not match root version "${rootVersion}" — resolve manually before bumping`,
    );
  }

  contents.version = newVersion;
  writeFileSync(filePath, `${JSON.stringify(contents, null, 2)}\n`);
  updates.push({
    name: contents.name ?? relativePath,
    relativePath,
    oldVersion,
    newVersion,
  });
}

for (const {
  name,
  relativePath,
  oldVersion,
  newVersion: updatedVersion,
} of updates) {
  console.log(
    `[dStorage] ${name} (${relativePath}): ${oldVersion} -> ${updatedVersion}`,
  );
}
console.log(
  `[dStorage] Bumped ${updates.length} package(s) to ${newVersion} (${bumpType})`,
);
