import { useEffect, useState } from "react";
import { apiBase } from "../../studioConfig";
import { apiFetch } from "../../shared/apiClient";

export function H3RegenerationStatusView({ hostedConfigured, hostedReason }: { hostedConfigured: boolean | null; hostedReason?: string }) {
  return <section className="h3ToolsSection" aria-label="H3 regeneration capabilities">
    <header><div><h2>Regenerate / Finalize 2K</h2><p>Local and hosted capabilities are checked separately.</p></div></header>
    <div className="h3ToolGrid">
      <article className="h3ToolCard">
        <div className="h3ToolCardStatus">Local unavailable</div>
        <h3>Local Regenerate 2K</h3>
        <p>No compatible local H3 regeneration backend is known/installed. The official H3-Regenerate-2K module has not been published.</p>
        <button type="button" disabled>Regenerate 2K · Local unavailable</button>
      </article>
      <article className="h3ToolCard">
        <div className="h3ToolCardStatus">{hostedConfigured === true ? "Configured · unverified" : hostedConfigured === false ? "Not configured" : "Configuration not checked"}</div>
        <h3>Hosted MiniMax Regeneration</h3>
        <p>{hostedReason ?? (hostedConfigured === false ? "MINIMAX_API_KEY is not configured." : "Separate paid MiniMax API. Credentials do not verify provider access or compatibility with a fal MP4.")}</p>
      </article>
    </div>
  </section>;
}

export function H3RegenerationStatus() {
  const [hostedConfigured, setHostedConfigured] = useState<boolean | null>(null);
  const [hostedReason, setHostedReason] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    void (async () => {
      try {
        const response = await apiFetch(`${apiBase}/api/h3-regeneration/availability`, { signal: controller.signal });
        const result = await response.json() as { ok?: boolean; available?: boolean; reason?: string };
        if (!response.ok || result.ok !== true || typeof result.available !== "boolean") throw new Error("Hosted configuration could not be checked.");
        if (!controller.signal.aborted) {
          setHostedConfigured(result.available);
          setHostedReason(result.reason);
        }
      } catch {
        if (!controller.signal.aborted) setHostedReason("Hosted configuration could not be checked.");
      } finally {
        window.clearTimeout(timeout);
      }
    })();
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, []);
  return <H3RegenerationStatusView hostedConfigured={hostedConfigured} hostedReason={hostedReason} />;
}
