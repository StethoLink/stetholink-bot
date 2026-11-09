import { AssistantPanel } from "@/features/assistant";

export default function WorkspacePage() {
  return (
    <main className="mx-auto w-full max-w-4xl p-6">
      <h1 className="mb-4 text-2xl font-semibold">StethoLink Workspace</h1>
      <AssistantPanel />
    </main>
  );
}
