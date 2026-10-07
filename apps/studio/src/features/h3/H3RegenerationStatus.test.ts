import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { H3RegenerationStatusView } from "./H3RegenerationStatus";

describe("H3 local / hosted regeneration status", () => {
  it("keeps local regeneration disabled even when the hosted API is configured", () => {
    const markup = renderToStaticMarkup(createElement(H3RegenerationStatusView, { hostedConfigured: true }));
    expect(markup).toContain("Local Regenerate 2K");
    expect(markup).toContain("Local unavailable");
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("Hosted MiniMax Regeneration");
    expect(markup).toContain("Configured · unverified");
    expect(markup).not.toContain("Verified");
    expect(markup).not.toContain("onClick");
  });

  it("shows missing hosted credentials separately from local availability", () => {
    const markup = renderToStaticMarkup(createElement(H3RegenerationStatusView, { hostedConfigured: false }));
    expect(markup).toContain("MINIMAX_API_KEY is not configured");
    expect(markup).toContain("Local unavailable");
    expect(markup).not.toContain("Configured · unverified");
  });

  it("does not interpret an unknown hosted status as configured", () => {
    const markup = renderToStaticMarkup(createElement(H3RegenerationStatusView, { hostedConfigured: null }));
    expect(markup).toContain("Configuration not checked");
    expect(markup).not.toContain("Configured · unverified");
  });
});
