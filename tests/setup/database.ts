import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Legt fuer den Testlauf eine echte SQLite-Datenbank an.
 *
 * Die Ablauflogik haengt an Unique-Constraints und Upserts - ein
 * nachgebauter Prisma-Mock wuerde genau die Eigenschaften wegabstrahieren,
 * auf die es ankommt.
 */
let directory: string;

export function setup() {
  directory = mkdtempSync(join(tmpdir(), "papierkram-test-"));
  const file = join(directory, "test.sqlite");
  process.env.DATABASE_URL = `file:${file}`;

  execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
    env: { ...process.env, DATABASE_URL: `file:${file}` },
    stdio: "pipe",
  });
}

export function teardown() {
  if (directory) rmSync(directory, { recursive: true, force: true });
}
