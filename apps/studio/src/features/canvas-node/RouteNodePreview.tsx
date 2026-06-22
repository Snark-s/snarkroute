import type { ImageViewerState } from "../../studioTypes";

export function CollapsedImagePreviewButton({
  src,
  title,
  filename,
  onOpenImage
}: {
  src: string;
  title: string;
  filename: string;
  onOpenImage?: (image: ImageViewerState) => void;
}) {
  return (
    <button
      className="collapsedImagePreviewButton nodrag nopan"
      type="button"
      title="View output image"
      onClick={(event) => {
        event.stopPropagation();
        onOpenImage?.({ src, title, filename });
      }}
    >
      <img className="collapsedImagePreview" src={src} alt="" />
    </button>
  );
}
