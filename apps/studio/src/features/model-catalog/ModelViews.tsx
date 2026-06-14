import type { ReactNode } from "react";
import type { ModelProfile } from "@snarkroute/protocol";
import type { ModelLogo } from "../../modelLogos";

export function ModelCapabilityBadges({ profile }: { profile: ModelProfile }) {
  const badges = [
    profile.capabilities.includes("vision") ? "Vision" : "",
    profile.capabilities.includes("tool_calling") ? "Tools" : "",
    profile.capabilities.includes("json_output") ? "JSON" : "",
    profile.costClass && profile.costClass !== "unknown" ? profile.costClass : "",
    profile.privacyClass && profile.privacyClass !== "unknown" ? profile.privacyClass : ""
  ].filter(Boolean);
  return (
    <span className="modelBadges">
      {badges.map((badge) => <em className={badge === "Vision" ? "vision" : ""} key={badge}>{badge}</em>)}
    </span>
  );
}

export function ModelLogoMark({ logo, size = "normal" }: { logo: ModelLogo; size?: "tiny" | "normal" }) {
  return <img className={`modelLogoMark ${size}`} src={logo.src} alt="" title={logo.label} width={size === "tiny" ? 16 : 24} height={size === "tiny" ? 16 : 24} loading="lazy" />;
}

export function ModelSelectWithLogo({ logo, children }: { logo: ModelLogo; children: ReactNode }) {
  return (
    <div className="nodeModelSelectRow">
      <ModelLogoMark logo={logo} />
      {children}
    </div>
  );
}
