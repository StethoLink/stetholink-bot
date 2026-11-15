// Admin preflight for the SMART registration. Run it with the same environment as the server
// (including NODE_EXTRA_CA_CERTS) before asking a clinician to sign in:
//
//   node --env-file=.env.local scripts/smart-preflight.mts
//
// It signs nobody in, reads no chart and prints no value from SMART_CLINICIAN_MAP.
// Exit code 0 when every check passes, 1 otherwise.
import { formatPreflight, runSmartPreflight } from "../integrations/fhir/smart-preflight.ts";

const checks = await runSmartPreflight(process.env);
console.log(formatPreflight(checks));
process.exit(checks.every((check) => check.ok) ? 0 : 1);
