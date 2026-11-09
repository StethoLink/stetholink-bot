"use client";

import { useEffect, useState } from "react";
import { getApiClient, type StethoLinkApiClient } from "@/shared/api-client";
import type { PatientContext } from "@/shared/contracts";

type State =
  | { status: "loading" }
  | { status: "ready"; patient: PatientContext }
  | { status: "error"; message: string };

export function usePatientContext(patientId: string, client: StethoLinkApiClient = getApiClient()): State {
  const [state, setState] = useState<State>({ status: "loading" });
  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    client
      .getPatientContext(patientId)
      .then((patient) => active && setState({ status: "ready", patient }))
      .catch(() => active && setState({ status: "error", message: "Could not load patient context" }));
    return () => {
      active = false;
    };
  }, [patientId, client]);
  return state;
}
