/** Provider-neutral model interface. The orchestrator depends only on this. */
export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  instructions: string;
  messages: ModelMessage[];
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
