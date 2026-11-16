import { describe, expect, it } from "vitest";
import { createFhirWriter } from "@/integrations/fhir/writer";
import type { ChartWriteItem } from "@/core/tools/chart-writer";

/** The FHIR writer for orders, against a fictional server. Every record, code and dose is fictional. */
const grant = { baseUrl: "https://ehr.example.test/fhir", accessToken: "fictional-token", patientId: "fic-pt-1", encounterId: "fic-enc-1", practitionerReference: "Practitioner/fic-dr-1",
  grantedScopes: ["launch", "patient/ServiceRequest.c", "patient/MedicationRequest.cruds", "patient/Observation.rs"] };
type Call = { method: string; url: string; headers: Headers; body?: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
function ehr(types: string[] = ["ServiceRequest", "MedicationRequest"], status = 201) {
  const calls: Call[] = [];
  const request = (async (target: URL | string | Request, init?: RequestInit) => {
    const url = String(target);
    calls.push({ method: init?.method ?? "GET", url, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/metadata")) return Response.json({ rest: [{ resource: types.map((type) => ({ type, interaction: [{ code: "create" }, { code: "read" }] })) }] });
    return Response.json({ id: "fic-created-1" }, { status });
  }) as typeof fetch;
  return { request, calls, posts: () => calls.filter((call) => call.method === "POST") };
}
const lab: ChartWriteItem = { kind: "service_request", itemKey: "sl-ord-aaaaaaaa000040008000000000000001", orderKind: "lab", display: "Complete blood count", code: { system: "urn:test", code: "CBC-1" },
  physicianNote: "Prepared with StethoLink and approved by the ordering physician." };
const medicine: ChartWriteItem = { kind: "medication_request", itemKey: "sl-ord-aaaaaaaa000040008000000000000002", display: "Amoxicillin 500 mg capsule",
  medication: { product: "Amoxicillin", dose: "500 mg", route: "oral", frequency: "every 8 hours", duration: "7 days" }, physicianNote: "Acknowledged: allergy. Reason: fictional." };

describe("writing an approved order to the EHR", () => {
  it("creates a service request conditionally, as a draft by default, for the launched patient and visit, with the catalog's code and the physician as requester", async () => {
    const { request, posts } = ehr();
    expect(await createFhirWriter(grant, request).create(lab)).toEqual({ status: "created", resourceType: "ServiceRequest", resourceId: "fic-created-1" });
    const [post] = posts();
    expect(post.url).toBe("https://ehr.example.test/fhir/ServiceRequest");
    expect(post.headers.get("if-none-exist")).toBe("identifier=" + encodeURIComponent("urn:stetholink:chart-write|sl-ord-aaaaaaaa000040008000000000000001"));
    expect(post.body).toMatchObject({
      resourceType: "ServiceRequest", status: "draft", intent: "order", category: [{ text: "lab" }], subject: { reference: "Patient/fic-pt-1" }, encounter: { reference: "Encounter/fic-enc-1" },
      requester: { reference: "Practitioner/fic-dr-1" }, code: { coding: [{ system: "urn:test", code: "CBC-1" }], text: "Complete blood count" },
      identifier: [{ system: "urn:stetholink:chart-write", value: "sl-ord-aaaaaaaa000040008000000000000001" }], note: [{ text: "Prepared with StethoLink and approved by the ordering physician." }],
    });
    expect(post.body!.authoredOn).toBeTruthy();
  });

  it("places the order only when the hospital says so", async () => {
    const { request, posts } = ehr();
    await createFhirWriter(grant, request, { orderStatus: "active" }).create(lab);
    expect(posts()[0].body).toMatchObject({ status: "active", intent: "order" });
  });

  it("creates a medication request with the catalog's product and dose as text, and no code the catalog did not give", async () => {
    const { request, posts } = ehr();
    expect(await createFhirWriter(grant, request).create(medicine)).toMatchObject({ status: "created", resourceType: "MedicationRequest" });
    const [post] = posts();
    expect(post.url).toBe("https://ehr.example.test/fhir/MedicationRequest");
    expect(post.body).toMatchObject({ resourceType: "MedicationRequest", status: "draft", intent: "order", medicationCodeableConcept: { text: "Amoxicillin" },
      dosageInstruction: [{ text: "500 mg, oral, every 8 hours, 7 days" }], note: [{ text: "Acknowledged: allergy. Reason: fictional." }], subject: { reference: "Patient/fic-pt-1" } });
    expect(post.body!.medicationCodeableConcept).not.toHaveProperty("coding");
    const withCode = ehr();
    await createFhirWriter(grant, withCode.request).create({ ...medicine, code: { system: "urn:test", code: "AMX-5", display: "Amoxicillin" } } as ChartWriteItem);
    expect(withCode.posts()[0].body!.medicationCodeableConcept).toEqual({ coding: [{ system: "urn:test", code: "AMX-5", display: "Amoxicillin" }], text: "Amoxicillin" });
  });

  it("decides support for each resource on its own: a scope the EHR did not grant, or a resource its capability statement does not offer, is unsupported", async () => {
    // OpenEMR 7.0.3's statement: no ServiceRequest, MedicationRequest only to read.
    const openemr = ehr([]);
    const writer = createFhirWriter(grant, openemr.request);
    expect(await writer.create(lab)).toMatchObject({ status: "unsupported", resourceType: "ServiceRequest", failure: expect.stringContaining("does not accept") });
    expect(await writer.create(medicine)).toMatchObject({ status: "unsupported", resourceType: "MedicationRequest" });
    expect(openemr.posts()).toHaveLength(0);
    // A hospital EHR that takes service requests and not medication requests.
    const partial = ehr(["ServiceRequest"]);
    const mixed = createFhirWriter(grant, partial.request);
    expect(await mixed.create(lab)).toMatchObject({ status: "created" });
    expect(await mixed.create(medicine)).toMatchObject({ status: "unsupported", resourceType: "MedicationRequest" });
    expect(partial.posts().map((call) => call.url.split("/").pop())).toEqual(["ServiceRequest"]);
    // Without the create scope nothing is attempted, even where the EHR would take it.
    const unscoped = ehr();
    const narrow = createFhirWriter({ ...grant, grantedScopes: ["launch", "patient/Observation.rs", "patient/MedicationRequest.rs"] }, unscoped.request);
    expect(await narrow.create(lab)).toMatchObject({ status: "unsupported", failure: expect.stringContaining("did not give StethoLink permission") });
    expect(await narrow.create(medicine)).toMatchObject({ status: "unsupported" });
    expect(unscoped.posts()).toHaveLength(0);
  });

  it("reports an existing record, and a refusal, without changing anything", async () => {
    expect(await createFhirWriter(grant, ehr(["ServiceRequest"], 200).request).create(lab)).toMatchObject({ status: "existing", resourceId: "fic-created-1" });
    const refused = ehr(["ServiceRequest"], 403);
    expect(await createFhirWriter(grant, refused.request).create(lab)).toMatchObject({ status: "failed", failure: "The EHR refused the write for this session" });
    expect(refused.posts()).toHaveLength(1);
    // Create only: nothing else is ever issued.
    expect(refused.calls.every((call) => ["GET", "POST"].includes(call.method))).toBe(true);
  });
});
