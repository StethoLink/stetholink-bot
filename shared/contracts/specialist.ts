import type { IsoDateTime } from "@/shared/types";
import type { DeliveryAttemptStatus, ProviderReport } from "./provider";

/** A consultation request as the receiving specialist sees it. It never carries a name, birth date or chart identifier. */
export interface SpecialistRequestSummary {
  requestId: string;
  status: DeliveryAttemptStatus;
  sentAt: IsoDateTime;
  specialty: string;
  question: string;
}
export interface SpecialistRequestView extends SpecialistRequestSummary {
  reason: string | null;
  /** The approved consultation text, exactly as the physician approved it. */
  summary: string;
  assessment: string;
  plan: string[];
  responses: { kind: "accepted" | "rejected" | "report"; receivedAt: IsoDateTime; reason?: string; report?: ProviderReport }[];
  canAccept: boolean;
  canDecline: boolean;
  canReport: boolean;
}
export interface SpecialistIdentity { displayName: string; service: string; expiresAt: number }
