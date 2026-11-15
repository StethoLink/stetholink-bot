// Retention job. Run it once a day (cron, systemd timer or a Kubernetes CronJob) with the
// maintenance login, never with the application's runtime login:
//
//   STETHOLINK_MAINTENANCE_DATABASE_URL=postgres://stetholink_maintenance:...@host/db \
//   RETENTION_SCRIBE_DAYS=30 RETENTION_CONSULTATION_DAYS=365 RETENTION_LEDGER_DAYS=400 node scripts/retention.mjs
//
// Expired sessions and transcripts past their date are always removed. A period left unset keeps
// that kind of record. The output is counts only.
import postgres from "postgres";

const url = process.env.STETHOLINK_MAINTENANCE_DATABASE_URL;
if (!url) throw new Error("Set STETHOLINK_MAINTENANCE_DATABASE_URL");
const days = (name) => {
  const raw = process.env[name];
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a whole number of days, at least 1`);
  return value;
};
const ca = process.env.STETHOLINK_DATABASE_CA;
const sql = postgres(url, { max: 1, onnotice: () => undefined, ssl: ca ? { ca, rejectUnauthorized: true } : undefined });
try {
  const [row] = await sql`select public.run_retention(${days("RETENTION_SCRIBE_DAYS")}, ${days("RETENTION_CONSULTATION_DAYS")}, ${days("RETENTION_LEDGER_DAYS")}) as result`;
  console.log(JSON.stringify({ action: "retention.run", ...row.result, at: new Date().toISOString() }));
} finally { await sql.end(); }
