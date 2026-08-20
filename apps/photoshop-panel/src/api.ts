export class SnarkRouteClient {
  constructor(private readonly baseUrl = "http://127.0.0.1:4317") {}
  async tools() { const response = await fetch(`${this.baseUrl}/api/tools?host=photoshop`); if (!response.ok) throw new Error(`SnarkRoute returned HTTP ${response.status}.`); return response.json() as Promise<{ tools: Array<{ tool: { id: string; title: string; description?: string } }> }>; }
}
