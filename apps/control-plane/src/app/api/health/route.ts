import { query } from "@/lib/db";
import { errorResponse } from "@/lib/errors";

export async function GET() {
  try {
    await query("SELECT 1");
    return Response.json({ status: "ok", service: "cloudagent-control-plane" });
  } catch (error) {
    return errorResponse(error);
  }
}
