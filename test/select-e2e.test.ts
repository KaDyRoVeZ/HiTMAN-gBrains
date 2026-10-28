// test/select-e2e.test.ts
//
// The E2E selector after narrowing retired (GBRA-47 C6): doc-only changes
// select nothing, every other change selects the whole corpus, and the CI
// path reads the changed-file list instead of git history.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classify, NARROWING_RETIRED, selectTests } from "../scripts/select-e2e.ts";

const ALL_E2E = ["test/e2e/sync.test.ts", "test/e2e/cycle.test.ts", "test/e2e/mechanical.test.ts"];
const SELECTOR = join(import.meta.dir, "../scripts/select-e2e.ts");

describe("classify", () => {
  test("empty -> EMPTY", () => {
    expect(classify([])).toBe("EMPTY");
  });
  test("only doc paths -> DOC_ONLY", () => {
    expect(classify(["README.md", "docs/foo.md", "CHANGELOG.md"])).toBe(
      "DOC_ONLY"
    );
  });
  test("any non-doc path -> SRC", () => {
    expect(classify(["README.md", "src/cli.ts"])).toBe("SRC");
  });
  test("skills/ is NOT doc-only (Codex F4)", () => {
    expect(classify(["skills/RESOLVER.md"])).toBe("SRC");
  });
});

describe("selectTests", () => {
  test("a doc-only change selects nothing", () => {
    expect(selectTests(["docs/guides/example.md", "README.md"], ALL_E2E)).toEqual([]);
  });
  test.each([
    ["an empty change", []],
    ["a source change", ["src/core/search/intent.ts"]],
    ["a direct test edit", ["test/e2e/sync.test.ts"]],
    ["a workflow edit", [".github/workflows/e2e.yml"]],
    ["mixed docs and source", ["docs/foo.md", "src/cli.ts"]],
  ])("%s selects the whole corpus, sorted", (_label, changed) => {
    expect(selectTests(changed, ALL_E2E)).toEqual([...ALL_E2E].sort());
  });
});

describe("selector CLI", () => {
  function run(args: string[], files: Record<string, string> = {}, input?: string) {
    const dir = mkdtempSync(join(tmpdir(), "gbrain-select-e2e-"));
    try {
      const git = (...a: string[]) => expect(spawnSync("git", a, { cwd: dir, encoding: "utf8" }).status).toBe(0);
      git("init", "-q");
      git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "base");
      git("update-ref", "refs/remotes/origin/master", "HEAD");
      mkdirSync(join(dir, "test/e2e"), { recursive: true });
      for (const file of ["test/e2e/a.test.ts", "test/e2e/b.test.ts"]) writeFileSync(join(dir, file), "// fixture\n");
      for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), body);
      return spawnSync(process.execPath, ["--no-env-file", SELECTOR, ...args], { cwd: dir, encoding: "utf8", input });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a code change in the working tree lists every E2E file and says narrowing is retired", () => {
    const r = run([]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("test/e2e/a.test.ts\ntest/e2e/b.test.ts\n");
    expect(r.stderr).toContain(NARROWING_RETIRED);
  });

  test("--changed-files reads the CI list: doc-only selects nothing", () => {
    const r = run(["--changed-files", "changed.txt"], { "changed.txt": "docs/a.md\nREADME.md\n" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).not.toContain(NARROWING_RETIRED);
  });

  test("--changed-files - reads stdin; an empty list (fail-closed fallback) selects everything", () => {
    const r = run(["--changed-files", "-"], {}, "");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("test/e2e/a.test.ts\ntest/e2e/b.test.ts\n");
  });

  test("--classify-only prints the classification of the given list", () => {
    const r = run(["--changed-files", "-", "--classify-only"], {}, "src/cli.ts\n");
    expect(r.stdout).toBe("SRC\n");
  });

  test("--changed-files without a value exits 2", () => {
    expect(run(["--changed-files"]).status).toBe(2);
  });
});
