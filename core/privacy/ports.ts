/** One person the chart names. `given[0]` is the person's own name; later ones are usually a father's and grandfather's. */
export interface PersonIdentity {
  role: "patient" | "relative" | "staff";
  sex?: "male" | "female";
  names: ReadonlyArray<{ text?: string; given?: readonly string[]; family?: string }>;
}

/** Everything the EHR supplied that identifies someone. Read for one session, held in memory, never stored or logged. */
export interface ChartIdentity {
  people: readonly PersonIdentity[];
  /** Record numbers, national and insurance numbers, phone numbers, e-mail addresses, record and visit ids. */
  identifiers: readonly string[];
  /** Street lines and postal codes. */
  addresses?: readonly string[];
  /** Start of the visit: day 0 of the relative dates. */
  anchorDate?: string;
}

/** Implemented by a clinical data connector that can say who the chart names. */
export interface IdentitySource {
  getIdentity(): Promise<ChartIdentity>;
}

/**
 * Where the stand-in map of a session is kept between requests. The value holds real identifiers:
 * an implementation keeps it in server memory or encrypted session storage, drops it when the
 * session expires, and never logs or sends it.
 */
export interface SurrogateVault<State> {
  open(sessionKey: string, expiresAt: number, create: () => State): State;
}

/** What the model boundary needs to de-identify one session's requests. */
export interface ModelPrivacy {
  /** Distinct per signed-in session. */
  sessionKey: string;
  /** Epoch milliseconds at which the session, and with it the stand-in map, ends. */
  expiresAt: number;
  identity(): Promise<ChartIdentity>;
}
