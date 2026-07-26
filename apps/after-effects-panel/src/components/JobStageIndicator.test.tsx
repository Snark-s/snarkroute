// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { JobStageIndicator } from "./JobStageIndicator";

afterEach(cleanup);

describe("JobStageIndicator", () => {
  it("marks provider_running as active and running", () => {
    render(<JobStageIndicator stage="provider_running" status="completed" message="Generating" />);
    expect(screen.getByRole("status")).toHaveProperty("className", "job-stage job-stage-active job-stage-running");
  });

  it("marks completed as success without the running class", () => {
    render(<JobStageIndicator stage="completed" status="completed" />);
    expect(screen.getByRole("status").className).toBe("job-stage job-stage-success");
  });

  it("marks failed as an error", () => {
    render(<JobStageIndicator stage="failed" status="failed" />);
    expect(screen.getByRole("status").className).toBe("job-stage job-stage-error");
  });

  it("renders an unknown stage neutrally", () => {
    render(<JobStageIndicator stage="future_stage" status="future_status" />);
    expect(screen.getByRole("status").className).toBe("job-stage job-stage-idle");
    expect(screen.getByText("Stage: future_stage")).toBeTruthy();
  });

  it("disables the running animation when reduced motion is preferred", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.job-stage-running \.job-stage-dot\s*\{\s*animation:\s*none/);
  });
});
