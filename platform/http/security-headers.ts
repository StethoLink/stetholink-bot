/**
 * Response headers that keep StethoLink inside the hospital's EHR and keep the page from talking to anyone else.
 * Plain module (no Node or Next import): the middleware and the tests both use it.
 *
 * - `frame-ancestors`: only the tenant's EHR may put StethoLink in a frame.
 * - Everything the page loads or calls (scripts, styles, fonts, images, fetch, media, workers) is this origin only,
 *   so a third-party font, analytics script or CDN cannot run even if one is added by mistake.
 */
export interface FrameEnv {
  /** Optional explicit list (space or comma separated HTTPS origins) for an EHR whose pages are not on its sign-in origin. */
  EHR_FRAME_ORIGINS?: string;
  /** The EHR's sign-in page: a page of the EHR as the browser sees it, so its origin is the default embedding origin. */
  SMART_AUTHORIZATION_URL?: string;
  NODE_ENV?: string;
}

function httpsOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    // An origin only: no path, query, wildcard or credentials can widen the policy.
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    // Exactly scheme, host and optional port, in plain characters: nothing that could end or extend a header value.
    return /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/.test(url.origin) && value.replace(/\/$/, "").toLowerCase() === url.origin ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function originOf(address: string | undefined): string | undefined {
  try {
    return address ? httpsOrigin(new URL(address).origin) : undefined;
  } catch {
    return undefined;
  }
}

/** A malformed entry is a configuration error, reported at startup by `frameOriginProblems`; here it is simply not allowed. */
export function ehrFrameOrigins(env: FrameEnv): string[] {
  const listed = (env.EHR_FRAME_ORIGINS ?? "").split(/[\s,]+/).filter(Boolean);
  const origins = listed.length ? listed.map(httpsOrigin) : [originOf(env.SMART_AUTHORIZATION_URL)];
  return [...new Set(origins.filter((origin): origin is string => !!origin))];
}

export function frameOriginProblems(env: FrameEnv): string[] {
  const listed = (env.EHR_FRAME_ORIGINS ?? "").split(/[\s,]+/).filter(Boolean);
  return listed.some((entry) => !httpsOrigin(entry))
    ? ["EHR_FRAME_ORIGINS must be a list of HTTPS origins (scheme, host and optional port; no path and no wildcard)"]
    : [];
}

export function contentSecurityPolicy(env: FrameEnv, nonce: string): string {
  const ancestors = ehrFrameOrigins(env);
  // Next's development server evaluates code for hot reload; a production build never needs it.
  const development = env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development}`,
    // React writes inline style attributes (widths of skeleton lines and progress bars). No stylesheet comes from elsewhere.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${env.NODE_ENV === "development" ? " ws: wss:" : ""}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    `frame-ancestors ${ancestors.length ? ancestors.join(" ") : "'none'"}`,
  ].join("; ");
}

/** Headers for every response. `X-Frame-Options` is left out on purpose: it cannot name another origin, `frame-ancestors` can. */
export function securityHeaders(env: FrameEnv, nonce: string): Record<string, string> {
  return {
    "Content-Security-Policy": contentSecurityPolicy(env, nonce),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    // The scribe needs the microphone; the EHR's frame must also carry allow="microphone". Nothing else is used.
    "Permissions-Policy": "microphone=(self), camera=(), geolocation=(), payment=(), usb=(), display-capture=()",
  };
}
