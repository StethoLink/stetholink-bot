/** Shared contracts, version 1.1.0. See docs/api-contracts/README.md. */
export type * from "./patient";
export type * from "./encounter";
export type * from "./chat";
export type * from "./consultation";
export type * from "./errors";
export type * from "./clinical-data";
export type * from "./clinician";
export type * from "./attachment";
export type { CreateConsultationDraftRequest } from "./routes";
export { apiRoutes } from "./routes";
