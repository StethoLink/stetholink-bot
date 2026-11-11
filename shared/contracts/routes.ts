/** HTTP route table: the single seam between the frontend and the backend. Paths are relative to the origin. */
export const apiRoutes = {
  health: { method: "GET", path: () => "/api/health" },
  chat: { method: "POST", path: () => "/api/chat" },
  patientContext: {
    method: "GET",
    path: (patientId: string) => `/api/patients/${encodeURIComponent(patientId)}/context`,
  },
  encounterContext: {
    method: "GET",
    path: (encounterId: string) => `/api/encounters/${encodeURIComponent(encounterId)}`,
  },
  createConsultationDraft: { method: "POST", path: () => "/api/consultations/drafts" },
  getConsultationDraft: {
    method: "GET",
    path: (draftId: string) => `/api/consultations/drafts/${encodeURIComponent(draftId)}`,
  },
  submitApproval: {
    method: "POST",
    path: (draftId: string) => `/api/consultations/drafts/${encodeURIComponent(draftId)}/approval`,
  },
} as const;

export interface CreateConsultationDraftRequest {
  patientId: string;
  encounterId?: string;
  conversationId?: string;
  /** Reuse the same key after a timeout; changing its request returns 409. */
  idempotencyKey?: string;
}
