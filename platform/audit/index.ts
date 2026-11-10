import "server-only";

export function auditConsultation(event: {
  action: "consultation.routed";
  tenantId: string;
  clinicianId: string;
  draftId: string;
}) {
  console.info(JSON.stringify({ ...event, at: new Date().toISOString() }));
}
