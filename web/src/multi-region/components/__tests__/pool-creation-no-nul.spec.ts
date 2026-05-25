/**
 * Regression test: pool-creation-page.tsx must never contain NUL bytes.
 *
 * On 2026-05-25 the file was found to contain two NUL chars (0x00) inside a
 * template-literal expression — an accidental "Mongolian vowel separator"
 * style binary contamination from an earlier edit. NULs break:
 *   - `git diff` (file flagged as binary)
 *   - Grep / ripgrep content scans
 *   - Code-review tooling
 *   - Some TypeScript compilers / linters
 *
 * This test reads the file as raw bytes and asserts no NULs are present.
 * If it fails again, locate the offending offset(s) printed in the error
 * message and inspect with a hex viewer.
 */
import * as fs from "fs";
import * as path from "path";

const POOL_CREATION_PATH = path.resolve(
  __dirname,
  "..",
  "pool-creation",
  "pool-creation-page.tsx",
);

describe("pool-creation-page.tsx integrity", () => {
  it("contains no NUL bytes", () => {
    const data = fs.readFileSync(POOL_CREATION_PATH);
    const positions: number[] = [];
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0x00) positions.push(i);
    }
    if (positions.length > 0) {
      throw new Error(
        `pool-creation-page.tsx contains ${positions.length} NUL byte(s) at offsets ${positions.slice(0, 10).join(", ")}${positions.length > 10 ? "..." : ""}. Use a hex viewer to locate and strip them.`,
      );
    }
    expect(positions).toEqual([]);
  });

  it("source file size is sane (not truncated)", () => {
    const stat = fs.statSync(POOL_CREATION_PATH);
    expect(stat.size).toBeGreaterThan(10_000);
  });
});
