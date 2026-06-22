import { filenameFromPath } from "../../shared/fileHelpers";
import { localImagePreviewSrc } from "../../shared/mediaPreview";
import type { AssetKind, ImageViewerState } from "../../studioTypes";

export function AssetNodeParams({
  type,
  params,
  canBrowseLocalFiles,
  onBrowse,
  onOpenImage
}: {
  type: string;
  params: Record<string, unknown>;
  canBrowseLocalFiles: boolean;
  onBrowse: (kind: AssetKind) => void;
  onOpenImage?: (image: ImageViewerState) => void;
}) {
  const kind = type.split(".")[1] as AssetKind;
  const path = String(params.path ?? "");
  const imageSrc = type === "input.image" && path ? localImagePreviewSrc(path) : "";
  return (
    <div className="assetParams">
      <label className="nodeField">
        <span>file</span>
        <input
          className="nodrag nopan nodeInput"
          value={path ? filenameFromPath(path) : ""}
          placeholder="No file selected"
          title={path}
          readOnly
        />
      </label>
      {canBrowseLocalFiles ? <button className="nodeSmallButton nodrag nopan" onClick={() => onBrowse(kind)}>Browse...</button> : null}
      {!path ? <div className="nodeWarning">Path required</div> : null}
      {imageSrc ? (
        <button
          className="nodeImagePreviewButton nodrag nopan"
          type="button"
          title="View image"
          onClick={() => onOpenImage?.({ src: imageSrc, title: filenameFromPath(path), filename: filenameFromPath(path) })}
        >
          <img className="nodeImagePreview" src={imageSrc} alt="" />
        </button>
      ) : null}
    </div>
  );
}
