import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ChatMessageItem,
  ChatPanel,
  chatReducer,
  initialChatState,
  lastFailedEntry,
  sendChat,
  type ChatAction,
  type ChatState,
} from "@/features/assistant";
import { ApiClientError, createMockApiClient, type StethoLinkApiClient } from "@/shared/api-client";

// Vitest cannot run the PostCSS config (see docs/agent-handoffs/2026-11-09-claude-frontend-test-deps.md).
// Vitest compiles JSX with the classic runtime until esbuild.jsx is set to "automatic".
(globalThis as { React?: typeof React }).React = React;
vi.mock("@/features/assistant/styles/chat.module.css", () => ({ default: {} }));


function harness() {
  let state: ChatState = initialChatState;
  const dispatch = (a: ChatAction) => {
    state = chatReducer(state, a);
  };
  return { dispatch, get: () => state };
}

function flakyClient(failures: number): StethoLinkApiClient {
  const base = createMockApiClient();
  let left = failures;
  return {
    ...base,
    async sendChatMessage(req) {
      if (left-- > 0) throw new ApiClientError("provider_unavailable", "Model provider unavailable", 503);
      return base.sendChatMessage(req);
    },
  };
}

describe("chat state", () => {
  it("adds the clinician message and the assistant reply with safety metadata", async () => {
    const h = harness();
    await sendChat(createMockApiClient(), h.dispatch, { text: "Summarize", patientId: "syn-pt-001" });
    const s = h.get();
    expect(s.status).toBe("idle");
    expect(s.conversationId).toBeDefined();
    expect(s.entries.map((e) => e.message.role)).toEqual(["clinician", "assistant"]);
    expect(s.entries[1].safety?.level).toBe("ok");
    expect(s.entries[1].requiresClinicianReview).toBe(true);
  });

  it("marks the message as failed with the API error message", async () => {
    const h = harness();
    await sendChat(flakyClient(1), h.dispatch, { text: "Hi" });
    expect(h.get().status).toBe("error");
    expect(h.get().error).toBe("Model provider unavailable");
    expect(lastFailedEntry(h.get())?.message.content).toBe("Hi");
  });

  it("retry resends the failed message without duplicating it", async () => {
    const client = flakyClient(1);
    const h = harness();
    await sendChat(client, h.dispatch, { text: "Hi" });
    const failed = lastFailedEntry(h.get())!;
    await sendChat(client, h.dispatch, { text: failed.message.content, retryOf: failed.message.id });
    const s = h.get();
    expect(s.status).toBe("idle");
    expect(s.error).toBeUndefined();
    expect(s.entries.filter((e) => e.message.role === "clinician")).toHaveLength(1);
    expect(lastFailedEntry(s)).toBeUndefined();
  });

  it("uses a generic message for non-API errors", async () => {
    const client = { ...createMockApiClient(), sendChatMessage: async () => Promise.reject(new Error("x")) };
    const h = harness();
    await sendChat(client, h.dispatch, { text: "Hi" });
    expect(h.get().error).toBe("The assistant could not be reached.");
  });
});

describe("chat components", () => {
  it("labels assistant output as AI-generated with safety level and review note", () => {
    const html = renderToStaticMarkup(
      createElement(ChatMessageItem, {
        entry: {
          message: { id: "m1", role: "assistant", content: "Reply", createdAt: "2026-11-09T00:00:00.000Z" },
          safety: { level: "caution", reasons: ["Dose not verified"] },
          requiresClinicianReview: true,
        },
      }),
    );
    expect(html).toContain("AI-generated");
    expect(html).toContain("Safety: caution");
    expect(html).toContain("Dose not verified");
    expect(html).toContain("Needs clinician review");
  });

  it("renders an empty state and a labelled input", () => {
    const html = renderToStaticMarkup(createElement(ChatPanel, { client: createMockApiClient() }));
    expect(html).toContain("No messages yet");
    expect(html).toContain("Message the assistant");
  });
});
