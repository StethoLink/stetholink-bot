/** Shared contracts, version 1.0.0. Codex owns changes; follow docs/agent-handoffs/CONTRACT-CHANGES.md. */
export type * from "./patient";
export type * from "./encounter";
export type * from "./chat";
export type * from "./consultation";
export type * from "./errors";
export type { CreateConsultationDraftRequest } from "./routes";
export { apiRoutes } from "./routes";
