// FICTIONAL-data test stack: TLS on 3082 in front of the app on 3081. node proxy.mts <dir with key.pem and cert.pem>
import { readFileSync } from "node:fs";
import { startTlsProxy } from "../../fakes/tls.mts";
const dir = process.argv[2];
await startTlsProxy({ key: readFileSync(`${dir}/key.pem`), cert: readFileSync(`${dir}/cert.pem`) }, 3082, 3081);
console.log("tls proxy 3082 -> 3081");
setInterval(() => undefined, 1 << 30);
