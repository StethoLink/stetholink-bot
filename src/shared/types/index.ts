/** Generic helper types. Domain types live in @/shared/contracts. */
export type IsoDateTime = string;
export type IsoDate = string;
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };
