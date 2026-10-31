#!/usr/bin/env node
// Страж согласованности Паспорта Мастерской (решение D-12).
// Проверяет: паспорт и его версию, существование путей, порты против service-endpoints.json,
// реестр решений, ссылки на паспорт в AGENTS.md/CLAUDE.md, отсутствие устаревших утверждений,
// и (с --git) что в каждом репозитории в бою стоит main.
// Запуск: node scripts/passport-check.mjs [--git] [--json]. Код выхода 1 при ошибках.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATUSES = new Set(["принято", "предложено", "заменено"]);
const MAX_PASSPORT_LINES = 150;

/** Пути из обратных кавычек и markdown-ссылок, которые можно проверить на диске. */
export function extractPaths(markdown) {
  const found = new Set();
  for (const m of markdown.matchAll(/`([^`\n]+)`/g)) {
    const value = m[1].trim();
    if (/^[A-Z]:\\/.test(value) || /^(docs|apps|scripts|data|packages|workers)\//.test(value)) found.add(value);
  }
  for (const m of markdown.matchAll(/\]\(([^)\s]+\.md)\)/g)) {
    if (!/^[a-z]+:\/\//i.test(m[1])) found.add(`docs/${m[1]}`);
  }
  return [...found];
}

/** Решения вида `### D-01 · принято · Заголовок`. */
export function parseDecisions(markdown) {
  const decisions = [];
  for (const m of markdown.matchAll(/^###\s+([A-Z]-\d{2})\s+·\s+([^·\n]+?)\s+·\s+(.+)$/gm)) {
    decisions.push({ id: m[1], status: m[2].trim(), title: m[3].trim() });
  }
  return decisions;
}

function listFiles(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? listFiles(join(path, entry.name)) : /\.(md|ts|mjs|json)$/.test(entry.name) ? [join(path, entry.name)] : []);
}

function resolvePath(root, value) {
  return /^[A-Z]:\\/.test(value) ? value : join(root, value);
}

export function checkPassport(root = DEFAULT_ROOT, options = {}) {
  const errors = [];
  const warnings = [];
  const read = rel => readFileSync(join(root, rel), "utf8");

  const manifestPath = join(root, "docs", "workshop-passport.json");
  if (!existsSync(manifestPath)) return { errors: ["нет docs/workshop-passport.json"], warnings };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  // 1. Паспорт и версия.
  if (!existsSync(join(root, manifest.document))) errors.push(`нет паспорта ${manifest.document}`);
  const passport = existsSync(join(root, manifest.document)) ? read(manifest.document) : "";
  if (passport && !passport.includes(`Версия паспорта: ${manifest.passportVersion}`)) errors.push(`версия в ${manifest.document} не равна ${manifest.passportVersion}`);
  const lines = passport.split(/\r?\n/).length;
  if (lines > MAX_PASSPORT_LINES) errors.push(`паспорт ${lines} строк, предел ${MAX_PASSPORT_LINES}`);

  // 2. Пути из паспорта существуют.
  for (const value of extractPaths(passport)) {
    if (!existsSync(resolvePath(root, value))) errors.push(`путь из паспорта не найден: ${value}`);
  }

  // 3. Порты совпадают с service-endpoints.json и упомянуты в паспорте.
  const endpoints = JSON.parse(read("service-endpoints.json")).services ?? {};
  for (const [id, port] of Object.entries(manifest.services ?? {})) {
    if (!endpoints[id]) errors.push(`сервиса ${id} нет в service-endpoints.json`);
    else if (endpoints[id].port !== port) errors.push(`порт ${id}: паспорт ${port}, service-endpoints.json ${endpoints[id].port}`);
    if (!passport.includes(String(port))) errors.push(`порт ${port} (${id}) не указан в паспорте`);
  }

  // 4. Реестр решений.
  const registry = existsSync(join(root, manifest.decisions)) ? read(manifest.decisions) : "";
  if (!registry) errors.push(`нет реестра решений ${manifest.decisions}`);
  const decisions = parseDecisions(registry);
  const seen = new Set();
  for (const d of decisions) {
    if (seen.has(d.id)) errors.push(`решение ${d.id} встречается дважды`);
    seen.add(d.id);
    if (!STATUSES.has(d.status)) errors.push(`решение ${d.id}: неизвестный статус «${d.status}»`);
  }
  for (const id of manifest.requiredAcceptedDecisions ?? []) {
    const d = decisions.find(x => x.id === id);
    if (!d) errors.push(`в реестре нет решения ${id}`);
    else if (d.status !== "принято") errors.push(`решение ${id} должно быть «принято», а не «${d.status}»`);
  }

  // 5. Инструкции агентов ссылаются на паспорт.
  for (const rel of manifest.mustReferencePassport ?? []) {
    if (!existsSync(join(root, rel)) || !read(rel).includes("WORKSHOP-PASSPORT.md")) errors.push(`${rel} не ссылается на WORKSHOP-PASSPORT.md`);
  }

  // 6. Устаревшие утверждения.
  const files = (manifest.staleClaimScan ?? []).flatMap(rel => listFiles(join(root, rel)));
  for (const file of files) {
    const text = readFileSync(file, "utf8").replace(/\s+/g, " ");
    for (const claim of manifest.staleClaims ?? []) {
      if (text.includes(claim.text)) errors.push(`устаревшее утверждение в ${file.slice(root.length + 1)}: «${claim.text}» — ${claim.why}`);
    }
  }

  // 7. Бой = main (по флагу: требует git).
  if (options.git) {
    for (const repo of manifest.repositories ?? []) {
      try {
        const git = args => execFileSync("git", ["-C", repo.path, ...args], { encoding: "utf8" }).trim();
        const head = git(["rev-parse", "HEAD"]);
        const main = git(["rev-parse", repo.deployedBranch]);
        if (head !== main) {
          const branch = git(["branch", "--show-current"]) || "detached";
          warnings.push(`${repo.id}: в рабочей копии ${branch} (${head.slice(0, 8)}), ${repo.deployedBranch} = ${main.slice(0, 8)}`);
        }
      } catch (error) {
        warnings.push(`${repo.id}: git недоступен (${error.message.split("\n")[0]})`);
      }
    }
  }

  return { version: manifest.passportVersion, decisions: decisions.length, errors, warnings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkPassport(DEFAULT_ROOT, { git: process.argv.includes("--git") });
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`passport-check: паспорт ${result.version ?? "?"}, решений ${result.decisions ?? 0}`);
    for (const w of result.warnings) console.log(`  предупреждение: ${w}`);
    for (const e of result.errors) console.log(`  ошибка: ${e}`);
    console.log(result.errors.length ? `НЕ ПРОЙДЕНО: ${result.errors.length} ошибок` : "ПРОЙДЕНО");
  }
  process.exitCode = result.errors.length ? 1 : 0;
}
