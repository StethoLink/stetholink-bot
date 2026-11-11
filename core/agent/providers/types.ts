/** Provider-neutral model interface. The orchestrator depends only on this. */
export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  instructions: string;
  messages: ModelMessage[];
  /** Set only after validating a synthetic adapter context; never from HTTP input. */
  dataClassification?: "synthetic";
  structuredOutput?: {
    name: string;
    schema: Record<string, unknown>;
  };
}

export interface ModelResult {
  text: string;
  provider: string;
  model: string;
}

export interface ModelProvider {
  readonly name: string;
  generate(request: ModelRequest): Promise<ModelResult>;
}
