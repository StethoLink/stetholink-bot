import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Test-only TLS. The product accepts only HTTPS for the EHR, the identity issuer, the model and
 * its own redirect URI, so the fakes and the app under test are served over HTTPS with a
 * throw-away certificate for localhost that the test processes trust through NODE_EXTRA_CA_CERTS.
 */
export async function ensureTrustedLocalhost(): Promise<{ key: Buffer; cert: Buffer }> {
  if (process.env.E2E_TLS_DIR) {
    return { key: readFileSync(join(process.env.E2E_TLS_DIR, "key.pem")), cert: readFileSync(join(process.env.E2E_TLS_DIR, "cert.pem")) };
  }
  const dir = mkdtempSync(join(tmpdir(), "stetholink-e2e-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:TRUE",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
  // Run this same script again with the certificate trusted from process start.
  const child = spawn(process.execPath, process.argv.slice(1), {
    stdio: "inherit", env: { ...process.env, E2E_TLS_DIR: dir, NODE_EXTRA_CA_CERTS: join(dir, "cert.pem") },
  });
  child.on("exit", (code) => process.exit(code ?? 1));
  // The parent only waits for the child; it never continues past this point.
  return new Promise(() => undefined);
}

/** Terminates TLS in front of the loopback app, keeping the Host header the browser used. */
export function startTlsProxy(tls: { key: Buffer; cert: Buffer }, listenPort: number, targetPort: number) {
  const server = https.createServer(tls, (req, res) => {
    const upstream = http.request({ host: "127.0.0.1", port: targetPort, method: req.method, path: req.url, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  return new Promise<https.Server>((resolve) => server.listen(listenPort, "127.0.0.1", () => resolve(server)));
}
