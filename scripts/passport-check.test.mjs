import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkPassport, extractPaths, parseDecisions } from "./passport-check.mjs";

function fixture({ claude = "see docs/WORKSHOP-PASSPORT.md", registryStatus = "принято", passportPort = "4317" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "passport-"));
  mkdirSync(join(root, "docs", "decisions"), { recursive: true });
  writeFileSync(join(root, "service-endpoints.json"), JSON.stringify({ services: { snarkroute: { port: 4317 } } }));
  writeFileSync(join(root, "AGENTS.md"), "Read docs/WORKSHOP-PASSPORT.md first.");
  writeFileSync(join(root, "CLAUDE.md"), claude);
  writeFileSync(join(root, "docs", "WORKSHOP-PASSPORT.md"), `# Паспорт\n\nВерсия паспорта: t.1\n\nSnarkRoute ${passportPort}, решения: [реестр](decisions/REGISTRY.md), \`docs/decisions/REGISTRY.md\`\n`);
  writeFileSync(join(root, "docs", "decisions", "REGISTRY.md"), `### D-01 · ${registryStatus} · Мост как DC\n### P-01 · предложено · Реестр\n`);
  writeFileSync(join(root, "docs", "workshop-passport.json"), JSON.stringify({
    passportVersion: "t.1", document: "docs/WORKSHOP-PASSPORT.md", decisions: "docs/decisions/REGISTRY.md",
    requiredAcceptedDecisions: ["D-01"], services: { snarkroute: 4317 },
    mustReferencePassport: ["AGENTS.md", "CLAUDE.md"],
    staleClaims: [{ text: "Ни один агент не пишет владельцу напрямую", why: "D-04" }],
    staleClaimScan: ["AGENTS.md", "CLAUDE.md"]
  }));
  return root;
}

test("согласованный паспорт проходит", () => {
  const root = fixture();
  try { assert.deepEqual(checkPassport(root).errors, []); } finally { rmSync(root, { recursive: true, force: true }); }
});

test("устаревшее утверждение, разорванное переносом строки, ловится", () => {
  const root = fixture({ claude: "docs/WORKSHOP-PASSPORT.md\nНи один агент не пишет\nвладельцу напрямую." });
  try { assert.match(checkPassport(root).errors.join("\n"), /устаревшее утверждение в CLAUDE\.md/); } finally { rmSync(root, { recursive: true, force: true }); }
});

test("принятое решение нельзя молча понизить", () => {
  const root = fixture({ registryStatus: "предложено" });
  try { assert.match(checkPassport(root).errors.join("\n"), /D-01 должно быть «принято»/); } finally { rmSync(root, { recursive: true, force: true }); }
});

test("отсутствие ссылки на паспорт и чужой порт — ошибки", () => {
  const root = fixture({ claude: "nothing here", passportPort: "9999" });
  try {
    const errors = checkPassport(root).errors.join("\n");
    assert.match(errors, /CLAUDE\.md не ссылается/);
    assert.match(errors, /порт 4317 \(snarkroute\) не указан/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("разбор путей и решений", () => {
  assert.deepEqual(extractPaths("`docs/a.md` `Y:\\X\\y` `buzha_message/status` [r](decisions/R.md)").sort(), ["Y:\\X\\y", "docs/a.md", "docs/decisions/R.md"].sort());
  assert.deepEqual(parseDecisions("### R-08 · заменено · Через Секретаря"), [{ id: "R-08", status: "заменено", title: "Через Секретаря" }]);
});
