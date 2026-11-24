import fs from "node:fs";
import path from "node:path";
import { createTursoD1Adapter, ensureAgenciesSeeded, splitSqlStatements } from "../packages/database/src/index";
import { BUILTIN_AGENCIES } from "../apps/api/src/env";

async function main() {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const token = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !token) {
    console.error("Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in your environment first.");
    process.exit(1);
  }

  const db = createTursoD1Adapter(url, token);
  const migrationsDir = path.resolve(process.cwd(), "packages/database/migrations");
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  console.log(`Applying ${files.length} migrations to Turso (${url})...`);
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    const stmts = splitSqlStatements(sql);
    let applied = 0;
    let skipped = 0;
    for (const stmt of stmts) {
      try {
        await db.prepare(stmt).run();
        applied++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/duplicate column name|already exists/i.test(msg)) {
          skipped++;
        } else {
          throw new Error(`Failed in ${file} on statement "${stmt.slice(0, 80)}...": ${msg}`);
        }
      }
    }
    console.log(`  ✓ ${file}: ${applied} applied, ${skipped} already present`);
  }

  console.log(`Seeding ${BUILTIN_AGENCIES.length} built-in Ontario agencies...`);
  await ensureAgenciesSeeded(db, BUILTIN_AGENCIES, true);

  const count = await db.prepare("SELECT COUNT(*) as c FROM agencies").first<{ c: number }>();
  const feedCount = await db.prepare("SELECT COUNT(*) as c FROM feeds").first<{ c: number }>();
  console.log(`Turso ready! Agencies: ${count?.c ?? 0}, Feeds: ${feedCount?.c ?? 0}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
