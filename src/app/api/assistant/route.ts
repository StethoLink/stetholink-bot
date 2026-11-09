import { NextResponse } from "next/server";
import { apiRoutes } from "@/shared/contracts";
import { assistantOrchestrator } from "@/server";

export async function POST(req: Request) {
  const parsed = apiRoutes.assistantMessage.request.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "invalid_request", message: parsed.error.message } },
      { status: 400 },
    );
  }
  const result = await assistantOrchestrator.handle(parsed.data);
  return NextResponse.json(apiRoutes.assistantMessage.response.parse(result));
}
