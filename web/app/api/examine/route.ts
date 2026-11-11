import { makeExamineHandler } from "@/lib/server/examine-handler";
import { examinerService } from "@/lib/server/examiner-service";

export async function POST(req: Request): Promise<Response> {
  let service;
  try {
    service = examinerService();
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
  return makeExamineHandler(service)(req);
}
