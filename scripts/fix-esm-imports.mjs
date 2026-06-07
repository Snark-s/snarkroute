import fs from "node:fs";
import path from "node:path";

const roots = process.argv.slice(2);

if (roots.length === 0) {
  console.error("Usage: node scripts/fix-esm-imports.mjs <dist-dir> [...]");
  process.exit(1);
}

const jsExtensionPattern = /\.[cm]?js$/;
const hasExtensionPattern = /\/[^/]+\.[^/]+$/;

function* walkFiles(root) {
  if (!fs.existsSync(root)) {
    return;
  }

  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (root.endsWith(".js")) {
      yield root;
    }
    return;
  }

  if (!stat.isDirectory()) {
    return;
  }

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      yield fullPath;
    }
  }
}

function resolveSpecifier(filePath, specifier) {
  if (!specifier.startsWith(".") || specifier.includes("?") || specifier.includes("#")) {
    return specifier;
  }

  if (jsExtensionPattern.test(specifier) || hasExtensionPattern.test(specifier)) {
    return specifier;
  }

  const basePath = path.resolve(path.dirname(filePath), specifier);
  if (fs.existsSync(`${basePath}.js`)) {
    return `${specifier}.js`;
  }

  if (fs.existsSync(path.join(basePath, "index.js"))) {
    return `${specifier}/index.js`;
  }

  return specifier;
}

function rewriteFile(filePath) {
  const original = fs.readFileSync(filePath, "utf8");
  let next = original;

  next = next.replace(
    /(\bfrom\s*["'])(\.\.?\/[^"']+)(["'])/g,
    (_, prefix, specifier, suffix) => `${prefix}${resolveSpecifier(filePath, specifier)}${suffix}`
  );

  next = next.replace(
    /(\bimport\s*["'])(\.\.?\/[^"']+)(["'])/g,
    (_, prefix, specifier, suffix) => `${prefix}${resolveSpecifier(filePath, specifier)}${suffix}`
  );

  next = next.replace(
    /(\bimport\s*\(\s*["'])(\.\.?\/[^"']+)(["']\s*\))/g,
    (_, prefix, specifier, suffix) => `${prefix}${resolveSpecifier(filePath, specifier)}${suffix}`
  );

  if (next !== original) {
    fs.writeFileSync(filePath, next);
    return 1;
  }

  return 0;
}

let files = 0;
let changed = 0;

for (const root of roots) {
  for (const filePath of walkFiles(root)) {
    files += 1;
    changed += rewriteFile(filePath);
  }
}

console.log(`ESM import specifiers checked: ${files} file(s), updated: ${changed}`);
