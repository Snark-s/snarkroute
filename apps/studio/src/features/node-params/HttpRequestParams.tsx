import type React from "react";

type TextParamUpdater = (
  key: string,
  event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  transform?: (value: string) => unknown
) => void;

export function HttpRequestParams({
  params,
  onChange,
  updateTextParam
}: {
  params: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
  updateTextParam: TextParamUpdater;
}) {
  const bodyMode = String(params.bodyMode ?? "none");
  return (
    <>
      <label className="nodeField">
        <span>url</span>
        <input className="nodrag nopan nodeInput" value={String(params.url ?? "")} onChange={(event) => updateTextParam("url", event)} />
      </label>
      <div className="nodeGridFields">
        <label className="nodeField">
          <span>method</span>
          <select className="nodrag nopan nodeInput nodeSelect" value={String(params.method ?? "GET")} onChange={(event) => onChange({ method: event.target.value })}>
            {["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => <option key={method} value={method}>{method}</option>)}
          </select>
        </label>
        <label className="nodeField">
          <span>response</span>
          <select className="nodrag nopan nodeInput nodeSelect" value={String(params.responseMode ?? "json")} onChange={(event) => onChange({ responseMode: event.target.value })}>
            {["json", "text"].map((mode) => <option key={mode} value={mode}>{mode}</option>)}
          </select>
        </label>
      </div>
      <label className="nodeField">
        <span>headers JSON</span>
        <textarea className="nodrag nopan nodeTextarea compact" value={formatJsonish(params.headers ?? {})} onChange={(event) => updateTextParam("headers", event)} />
      </label>
      <label className="nodeField">
        <span>query JSON</span>
        <textarea className="nodrag nopan nodeTextarea compact" value={formatJsonish(params.query ?? {})} onChange={(event) => updateTextParam("query", event)} />
      </label>
      <label className="nodeField">
        <span>body mode</span>
        <select className="nodrag nopan nodeInput nodeSelect" value={bodyMode} onChange={(event) => onChange({ bodyMode: event.target.value })}>
          <option value="none">none</option>
          <option value="rawJson">raw JSON</option>
          <option value="rawText">raw text</option>
        </select>
      </label>
      {bodyMode !== "none" ? (
        <label className="nodeField">
          <span>body</span>
          <textarea className="nodrag nopan nodeTextarea" value={String(params.body ?? "")} onChange={(event) => updateTextParam("body", event)} />
        </label>
      ) : null}
    </>
  );
}

function formatJsonish(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
