import type React from "react";
import type { NodeManifest } from "../../studioTypes";
import { GenericManifestParams, NodeSliderParam } from "./ParamRows";
import { numberParamValue } from "./paramHelpers";

type TextParamUpdater = (
  key: string,
  event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  transform?: (value: string) => unknown
) => void;

type ImageDimensions = {
  width: number;
  height: number;
};

export function FisheyeTransformParams({
  params,
  onChange
}: {
  params: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  return (
    <div className="fisheyeParams">
      <NodeSliderParam
        id="fovDegrees"
        label="angle"
        min={1}
        max={360}
        step={1}
        value={numberParamValue(params.fovDegrees, 200)}
        onChange={onChange}
      />
      <NodeSliderParam
        id="yawDegrees"
        label="yaw"
        min={-180}
        max={180}
        step={1}
        value={numberParamValue(params.yawDegrees, 0)}
        onChange={onChange}
      />
      <NodeSliderParam
        id="pitchDegrees"
        label="pitch"
        min={-90}
        max={90}
        step={1}
        value={numberParamValue(params.pitchDegrees, -90)}
        onChange={onChange}
      />
    </div>
  );
}

export function ImageResizeTransformParams({
  manifest,
  params,
  dimensions,
  status,
  onChange,
  updateTextParam
}: {
  manifest: NodeManifest;
  params: Record<string, unknown>;
  dimensions?: ImageDimensions | null;
  status?: string;
  onChange: (patch: Record<string, unknown>) => void;
  updateTextParam: TextParamUpdater;
}) {
  return (
    <>
      <div className="nodeMetaLine">
        Input image: {dimensions ? `${dimensions.width} x ${dimensions.height}px` : status === "loading" ? "loading size..." : status === "error" ? "size unavailable" : "not connected"}
      </div>
      <GenericManifestParams manifest={manifest} params={params} onChange={onChange} updateTextParam={updateTextParam} />
    </>
  );
}
