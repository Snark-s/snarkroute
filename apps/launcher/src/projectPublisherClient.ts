export type ProjectPublisherStatus = {
  ok: boolean;
  service: "project-publisher-control";
  port: number;
  url: string;
  root: string;
  available: boolean;
  running: boolean;
  healthy: boolean;
  managed: boolean;
  external: boolean;
  pid?: number;
  operation: null | { id: string; action: string; state: string; error?: string };
  error?: string;
};

async function parse(response: Response): Promise<ProjectPublisherStatus> {
  const result = await response.json() as ProjectPublisherStatus;
  if (!response.ok || !result.ok) throw new Error(result.error || "Project Publisher control is unavailable");
  return result;
}

export async function readProjectPublisherStatus(base: string, fetcher: typeof fetch = fetch) {
  return parse(await fetcher(`${base}/project-publisher/status`, { signal: AbortSignal.timeout(3000) }));
}

export async function changeProjectPublisher(
  base: string,
  action: "start" | "stop" | "restart",
  fetcher: typeof fetch = fetch
) {
  return parse(await fetcher(`${base}/project-publisher/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(70000)
  }));
}
