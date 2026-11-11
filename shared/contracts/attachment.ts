import type { ClinicalSource } from "./clinical-data";
import type { IsoDateTime } from "@/shared/types";

/** Metadata only. This contract does not upload, fetch or transfer attachments. */
export interface AttachmentReference {
  id: string;
  contentType: string;
  description?: string;
  source: ClinicalSource;
  timestamp: IsoDateTime;
}
