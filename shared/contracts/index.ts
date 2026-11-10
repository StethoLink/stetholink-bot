/** Shared contracts, version 1.0.0. See docs/api-contracts/README.md. */
export type * from "./patient";
export type * from "./encounter";
export type * from "./chat";
export type * from "./consultation";
export type * from "./errors";
export type { CreateConsultationDraftRequest } from "./routes";
export { apiRoutes } from "./routes";
