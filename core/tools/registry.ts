/**
 * Allowlist of tools the model may call. Each tool is a narrow, typed, read-only function
 * that runs with the caller's authorization. The model never gets database access, SQL, or credentials.
 */
import type { z } from "zod";

export interface ToolContext {
  clinicianId: string;
  patientId?: string;
}

export interface AiTool<I, O> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  run(input: I, ctx: ToolContext): Promise<O>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const toolRegistry: ReadonlyArray<AiTool<any, unknown>> = [];
