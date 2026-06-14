import type React from "react";
import { formatSliderValue } from "../../shared/mediaPreview";
import type { NodeManifest } from "../../studioTypes";
import { numericParam } from "./paramHelpers";

type TextParamUpdater = (
  key: string,
  event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  transform?: (value: string) => unknown
) => void;

export function NodeSliderParam({
  id,
  label,
  min,
  max,
  step,
  value,
  onChange
}: {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const displayValue = formatSliderValue(value);
  return (
    <label className="nodeSliderField">
      <span>{label}</span>
      <input
        className="nodrag nopan"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange({ [id]: numericParam(event.target.value) })}
      />
      <output>{displayValue}°</output>
    </label>
  );
}

export function GenericManifestParams({
  manifest,
  params,
  onChange,
  updateTextParam
}: {
  manifest: NodeManifest;
  params: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
  updateTextParam: TextParamUpdater;
}) {
  const renderParam = (param: NonNullable<NodeManifest["params"]>[number]) => {
    const control = manifest.ui?.params?.[param.id] ?? {};
    const value = params[param.id] ?? param.default ?? "";
    const label = param.label ?? param.id;
    const options = control.options ?? [];
    if (control.control === "slider") {
      const parsedValue = typeof value === "number" ? value : numericParam(String(value || param.default || 0));
      const numericValue = typeof parsedValue === "number" ? parsedValue : 0;
      const min = control.min ?? 0;
      const max = control.max ?? 100;
      const step = control.step ?? 1;
      return (
        <label className="nodeSliderField" key={param.id}>
          <span>{label}</span>
          <input
            className="nodrag nopan"
            type="range"
            min={min}
            max={max}
            step={step}
            value={numericValue}
            onChange={(event) => onChange({ [param.id]: numericParam(event.target.value) })}
          />
          <output>{numericValue}</output>
          {control.helperText ?? param.description ? <small className="nodeConnectedHint">{control.helperText ?? param.description}</small> : null}
        </label>
      );
    }
    if (options.length > 0 || control.control === "select") {
      return (
        <label className="nodeField" key={param.id}>
          <span>{label}</span>
          <select className="nodrag nopan nodeInput nodeSelect" value={String(value)} onChange={(event) => onChange({ [param.id]: event.target.value })}>
            {options.map((option) => {
              const optionValue = typeof option === "string" ? option : option.value;
              const optionLabel = typeof option === "string" ? option : option.label ?? option.value;
              return <option key={optionValue} value={optionValue}>{optionLabel}</option>;
            })}
          </select>
          {control.helperText ?? param.description ? <small className="nodeConnectedHint">{control.helperText ?? param.description}</small> : null}
        </label>
      );
    }
    if (param.type === "boolean" || control.control === "checkbox") {
      return (
        <label className="nodeCheckField" key={param.id}>
          <input className="nodrag nopan" type="checkbox" checked={Boolean(value)} onChange={(event) => onChange({ [param.id]: event.target.checked })} />
          <span>{label}</span>
        </label>
      );
    }
    if (param.type === "number" || control.control === "number") {
      return (
        <label className="nodeField" key={param.id}>
          <span>{label}</span>
          <input className="nodrag nopan nodeInput" inputMode="decimal" value={String(value)} onChange={(event) => updateTextParam(param.id, event, numericParam)} />
          {control.helperText ?? param.description ? <small className="nodeConnectedHint">{control.helperText ?? param.description}</small> : null}
        </label>
      );
    }
    const multiline = control.multiline === true || control.control === "textarea" || param.type === "json" || String(value).length > 80;
    const textareaSizeClass = control.size === "large" ? "large" : control.size === "compact" ? "compact" : "";
    return (
      <label className="nodeField" key={param.id}>
        <span>{label}</span>
        {multiline ? (
          <textarea
            className={`nodrag nopan nodeTextarea ${textareaSizeClass}`.trim()}
            value={typeof value === "string" ? value : JSON.stringify(value, null, 2)}
            placeholder={control.placeholder}
            onChange={(event) => updateTextParam(param.id, event)}
          />
        ) : (
          <input className="nodrag nopan nodeInput" value={String(value)} placeholder={control.placeholder} onChange={(event) => updateTextParam(param.id, event)} />
        )}
        {control.helperText ?? param.description ? <small className="nodeConnectedHint">{control.helperText ?? param.description}</small> : null}
      </label>
    );
  };
  const visibleParams = (manifest.params ?? []).filter((param) => manifest.ui?.params?.[param.id]?.advanced !== true);
  const advancedParams = (manifest.params ?? []).filter((param) => manifest.ui?.params?.[param.id]?.advanced === true);
  const requiredEnv = manifest.permissions?.env ?? [];
  const packageMeta = [manifest.author?.name, manifest.version, manifest.origin, manifest.source].filter(Boolean).join(" · ");
  const renderParamList = (items: NonNullable<NodeManifest["params"]>) => {
    const rendered: React.ReactNode[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const param = items[index];
      if (manifest.ui?.params?.[param.id]?.layout === "inline" && manifest.ui?.params?.[items[index + 1]?.id ?? ""]?.layout === "inline") {
        rendered.push(
          <div className="nodeInlineFields" key={`${param.id}-${items[index + 1].id}`}>
            {renderParam(param)}
            {renderParam(items[index + 1])}
          </div>
        );
        index += 1;
        continue;
      }
      rendered.push(renderParam(param));
    }
    return rendered;
  };
  return (
    <>
      {renderParamList(visibleParams)}
      {advancedParams.length > 0 || packageMeta || requiredEnv.length > 0 ? (
        <details className="nodeAdvanced compact">
          <summary>Advanced</summary>
          {requiredEnv.length > 0 ? <div className="nodeHint">Requires env: {requiredEnv.join(", ")}</div> : null}
          {packageMeta ? <div className="nodeMetaLine nodePackageMetaLine">{packageMeta}</div> : null}
          {renderParamList(advancedParams)}
        </details>
      ) : null}
    </>
  );
}
