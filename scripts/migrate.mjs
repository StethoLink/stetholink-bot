// Applies the SQL migrations in order, each once, with the database OWNER login (not the runtime login):
//
//   STETHOLINK_OWNER_DATABASE_URL=postgres://owner:...@host/db node scripts/migrate.mjs
//
// Applied file names are recorded in stetholink_migrations. A plain PostgreSQL 15+ database is enough;
// on a database that is not Supabase the script first creates the two roles and the auth helpers the
// first migrations refer to. Take a backup before running it on a database that holds data.
import { readFile, readdir } from "node:fs/promises";
import postgres from "postgres";

const url = process.env.STETHOLINK_OWNER_DATABASE_URL;
if (!url) throw new Error("Set STETHOLINK_OWNER_DATABASE_URL");
const ca = process.env.STETHOLINK_DATABASE_CA;
const sql = postgres(url, { max: 1, onnotice: () => undefined, ssl: ca ? { ca, rejectUnauthorized: true } : undefined });
try {
  await sql.unsafe(`create table if not exists public.stetholink_migrations (name text primary key, applied_at timestamptz not null default now());
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    end $$;
    create schema if not exists auth;
    do $$ begin
      if to_regprocedure('auth.uid()') is null then create function auth.uid() returns uuid language sql stable as 'select null::uuid'; end if;
      if to_regprocedure('auth.jwt()') is null then create function auth.jwt() returns jsonb language sql stable as 'select null::jsonb'; end if;
    end $$;`);
  const applied = new Set((await sql`select name from public.stetholink_migrations`).map((row) => row.name));
  for (const name of (await readdir("supabase/migrations")).filter((file) => file.endsWith(".sql")).sort()) {
    if (applied.has(name)) continue;
    const text = await readFile(`supabase/migrations/${name}`, "utf8");
    await sql.begin(async (tx) => { await tx.unsafe(text); await tx`insert into public.stetholink_migrations(name) values (${name})`; });
    console.log("Applied", name);
  }
  console.log("Migrations are up to date");
} finally { await sql.end(); }
