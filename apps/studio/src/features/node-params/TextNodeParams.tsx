import type React from "react";

type TextParamUpdater = (
  key: string,
  event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  transform?: (value: string) => unknown
) => void;

const textNodeParamTypes = new Set([
  "input.text",
  "transform.template",
  "text.promptCompose",
  "preview.image",
  "preview.panorama360",
  "output.text",
  "debug.log",
  "output.file"
]);

export function isTextNodeParamsType(type: string): boolean {
  return textNodeParamTypes.has(type);
}

export function TextNodeParams({
  type,
  params,
  onChange,
  updateTextParam
}: {
  type: string;
  params: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
  updateTextParam: TextParamUpdater;
}) {
  if (type === "input.text") {
    return (
      <label className="nodeField">
        <span>value</span>
        <textarea className="nodrag nopan nodeTextarea" value={String(params.value ?? "")} onChange={(event) => updateTextParam("value", event)} />
      </label>
    );
  }

  if (type === "transform.template") {
    return (
      <label className="nodeField">
        <span>template</span>
        <textarea className="nodrag nopan nodeTextarea" value={String(params.template ?? "")} onChange={(event) => updateTextParam("template", event)} />
      </label>
    );
  }

  if (type === "text.promptCompose") {
    const separator = String(params.separator ?? "\n\n");
    return (
      <>
        <label className="nodeField">
          <span>prompt</span>
          <textarea className="nodrag nopan nodeTextarea" value={String(params.manualText ?? "")} onChange={(event) => updateTextParam("manualText", event)} />
        </label>
        <label className="nodeField">
          <span>separator</span>
          <textarea className="nodrag nopan nodeTextarea compact" value={separator} onChange={(event) => updateTextParam("separator", event)} />
        </label>
        <div className="nodeGridFields">
          <label className="nodeCheckField">
            <input
              className="nodrag nopan"
              type="checkbox"
              checked={params.trimParts !== false}
              onChange={(event) => onChange({ trimParts: event.target.checked })}
            />
            <span>trimParts</span>
          </label>
          <label className="nodeCheckField">
            <input
              className="nodrag nopan"
              type="checkbox"
              checked={params.skipEmpty !== false}
              onChange={(event) => onChange({ skipEmpty: event.target.checked })}
            />
            <span>skipEmpty</span>
          </label>
        </div>
        <label className="nodeField">
          <span>prefix</span>
          <textarea className="nodrag nopan nodeTextarea compact" value={String(params.prefix ?? "")} onChange={(event) => updateTextParam("prefix", event)} />
        </label>
        <label className="nodeField">
          <span>suffix</span>
          <textarea className="nodrag nopan nodeTextarea compact" value={String(params.suffix ?? "")} onChange={(event) => updateTextParam("suffix", event)} />
        </label>
        <label className="nodeField">
          <span>preview</span>
          <textarea className="nodrag nopan nodeTextarea outputTextArea" value={composePromptPreview(params)} readOnly />
          <small className="nodeConnectedHint">Connected inputs are composed when the node runs.</small>
        </label>
      </>
    );
  }

  if (type === "preview.image") return null;

  if (type === "preview.panorama360") {
    return <div className="nodeHint">Connect an equirectangular 360 image, run the block, then drag the preview to look around.</div>;
  }

  if (type === "output.text") {
    return <div className="nodeHint">Text output</div>;
  }

  if (type === "debug.log") {
    return (
      <>
        <label className="nodeField">
          <span>message</span>
          <input className="nodrag nopan nodeInput" value={String(params.message ?? "")} onChange={(event) => updateTextParam("message", event)} />
        </label>
        <label className="nodeField">
          <span>value</span>
          <textarea className="nodrag nopan nodeTextarea" value={String(params.value ?? "")} onChange={(event) => updateTextParam("value", event)} />
        </label>
      </>
    );
  }

  if (type === "output.file") {
    return (
      <>
        <label className="nodeField">
          <span>filename</span>
          <input className="nodrag nopan nodeInput" value={String(params.filename ?? "")} onChange={(event) => updateTextParam("filename", event)} />
        </label>
        <label className="nodeField">
          <span>from</span>
          <textarea className="nodrag nopan nodeTextarea" value={String(params.from ?? "")} onChange={(event) => updateTextParam("from", event)} />
        </label>
      </>
    );
  }

  return null;
}

function composePromptPreview(params: Record<string, unknown>): string {
  const trimParts = params.trimParts !== false;
  const skipEmpty = params.skipEmpty !== false;
  const separator = String(params.separator ?? "\n\n");
  const manualText = params.manualText === undefined || params.manualText === null ? "" : String(params.manualText);
  const slotParts = promptComposeFixedSlots().flatMap((slot) => [1, 2, 3].map((index) => ({ slot, index, raw: params[`${slot.id}${index}`] })));
  const legacyParts = [1, 2, 3, 4, 5, 6].map((index) => ({ slot: { id: `text${index}`, label: `Text ${index}` }, index: 1, raw: params[`text${index}`] }));
  const hasSlotParts = slotParts.some((part) => part.raw !== undefined);
  const values = hasSlotParts ? slotParts : legacyParts;
  const parts = [
    { label: "Prompt", index: 1, value: trimParts ? manualText.trim() : manualText },
    ...values
      .map(({ slot, index, raw }) => {
        const text = raw === undefined || raw === null ? "" : String(raw);
        const value = trimParts ? text.trim() : text;
        return { label: slot.label, index, value };
      })
  ]
    .filter((part) => !skipEmpty || part.value !== "");
  const body = parts
    .map((part) => hasSlotParts && part.label !== "Prompt" ? `${part.label}${part.index > 1 ? ` ${part.index}` : ""}:\n${part.value}` : part.value)
    .join(separator);
  return `${String(params.prefix ?? "")}${body}${String(params.suffix ?? "")}`;
}

function promptComposeFixedSlots(): Array<{ id: string; label: string }> {
  return [
    { id: "subject", label: "Subject" },
    { id: "style", label: "Style" },
    { id: "scene", label: "Scene" }
  ];
}
