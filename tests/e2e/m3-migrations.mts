import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import postgres from "postgres";

// This harness owns its disposable database. Never point it at a cloud/project DB.
const url = process.env.STETHOLINK_TEST_OWNER_URL;
assert.ok(url, "Set STETHOLINK_TEST_OWNER_URL to a fresh disposable loopback database");
assert.ok(["127.0.0.1", "localhost"].includes(new URL(url).hostname), "Migration tests require loopback");
const sql = postgres(url, { max: 1, onnotice: () => undefined });
try {
  assert.equal((await sql`select count(*)::int as n from pg_tables where schemaname='public'`)[0].n, 0, "Use a fresh isolated database");
  await sql.unsafe(`create role anon; create role authenticated; create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select null::jsonb $$;`);
  for (const name of (await readdir("supabase/migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    if (name.includes("durable_consultation")) await sql.unsafe(await readFile("supabase/tests/m3_before.sql", "utf8"));
    await sql.unsafe(await readFile("supabase/migrations/" + name, "utf8"));
    console.log("Applied", name);
    const suites = name.includes("durable_consultation") ? ["clinician_access.sql", "durable_lifecycle.sql"] :
      name.includes("clinician_approval_boundary") ? ["m4_approval_boundary.sql"] :
      name.includes("provider_routing") ? ["provider_routing.sql"] : [];
    for (const suite of suites) {
      await sql.unsafe(await readFile("supabase/tests/" + suite, "utf8"));
      console.log("Passed", suite);
    }
  }
} finally { await sql.end(); }
