export { ConsultationReview } from "./components/ConsultationReview";
export { ConsultationDraftView } from "./components/ConsultationDraftView";
export { ApprovalControls, type ApprovalControlsProps } from "./components/ApprovalControls";
export { DraftStatusBadge } from "./components/DraftStatusBadge";
export { useConsultationDraft } from "./hooks/useConsultationDraft";
export {
  createDraft,
  decideDraft,
  draftReducer,
  initialDraftState,
  isFinalStatus,
  loadDraft,
} from "./hooks/draftState";
export type { DraftAction, DraftState } from "./hooks/draftState";

export { ConsultationComposer } from "./components/ConsultationComposer";
export { awaitingProvider, describeDelivery } from "./hooks/deliveryState";
export { ConsultationDelivery } from "./components/ConsultationDelivery";
export { StatusTracker } from "./components/StatusTracker";
export { consultationTracker } from "./hooks/statusTracker";
export type { AssistantInfo } from "./components/ConsultationComposer";
