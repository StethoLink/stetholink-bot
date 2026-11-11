#!/usr/bin/env node
// Local synthetic demonstration: disposable PostgreSQL + the embedded app on the fictional
// Ahmed cardiology chart. Synthetic data only; nothing here touches a cloud database.
//   npm run demo                      (needs Docker)
//   DEMO_DATABASE_OWNER_URL=postgres://postgres@127.0.0.1:5432/postgres npm run demo
//                                     (uses an EMPTY local PostgreSQL 15+ instead of Docker)
import { execFileSync, spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import postgres from "postgres";

const port = process.env.DEMO_PORT ?? "3000";
let container;
let ownerUrl = process.env.DEMO_DATABASE_OWNER_URL;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanup() {
  if (container) try { docker("rm", "-f", container); } catch { /* already gone */ }
}

try {
  if (!ownerUrl) {
    container = "stetholink-demo-" + process.pid;
    docker("run", "-d", "--name", container, "-p", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17");
    ownerUrl = `postgres://postgres@127.0.0.1:${docker("port", container, "5432/tcp").split(":").pop()}/postgres`;
  }
  const url = new URL(ownerUrl);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("The demo only uses a local, disposable database.");
  const sql = postgres(ownerUrl, { max: 1, onnotice: () => undefined, connect_timeout: 5 });
  for (let i = 0; ; i++) {
    try { await sql`select 1`; break; } catch (error) { if (i > 30) throw error; await sleep(1000); }
  }
  const [{ n }] = await sql`select count(*)::int as n from pg_tables where schemaname='public'`;
  if (n === 0) {
    // Stand-ins for the Supabase roles the migrations reference.
    await sql.unsafe(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create function auth.jwt() returns jsonb language sql stable as $$ select null::jsonb $$;`);
    for (const name of (await readdir("supabase/migrations")).filter((file) => file.endsWith(".sql")).sort()) {
      await sql.unsafe(await readFile("supabase/migrations/" + name, "utf8"));
    }
    console.log("Database prepared.");
  } else {
    const [{ ready }] = await sql`select to_regclass('public.consultation_provider_responses') is not null as ready`;
    if (!ready) throw new Error("This database is not empty and is not a StethoLink demo database. Use an empty one.");
    console.log("Reusing the existing demo database; earlier consultations are still there.");
  }
  await sql.end();

  url.username = "stetholink_runtime";
  const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "apps/embedded-app", "--hostname", "127.0.0.1", "--port", port], {
    stdio: "inherit",
    env: { ...process.env, AUTH_MODE: "dev", CLINICAL_DATA_SOURCE: "synthetic", AI_PROVIDER: "mock", NEXT_PUBLIC_API_MODE: "http",
      TENANT_ID: "local-synthetic", LOCAL_SYNTHETIC_CHART: "ahmed", STETHOLINK_DATABASE_URL: url.toString(),
      VERCEL_ENV: "", VERCEL_TARGET_ENV: "" },
  });
  console.log(`\nStethoLink synthetic demo: http://127.0.0.1:${port}/embed   (Ctrl+C to stop)\n`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => app.kill(signal));
  await new Promise((resolve) => app.on("exit", resolve));
} finally {
  cleanup();
}
