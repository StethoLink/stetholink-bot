import { NextResponse } from "next/server";
import { API_VERSION } from "@/shared/constants";

export function GET() {
  return NextResponse.json({ status: "ok", version: API_VERSION });
}
