// POST /api/extract — placeholder. The Gemini extraction (server/extract.ts) replaces this.
// It answers 501 rather than returning sample restrictions, so nothing fake can reach the UI.

export async function POST(_request: Request): Promise<Response> {
  return Response.json({ error: 'not implemented yet' }, { status: 501 });
}
