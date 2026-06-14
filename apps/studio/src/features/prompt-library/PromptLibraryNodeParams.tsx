import { useState, type ChangeEvent, type MouseEvent } from "react";
import { apiBase, promptStatusOptions } from "../../studioConfig";
import type { PromptLibraryData, PromptLibraryPrompt, PromptStatusFilter } from "../../studioTypes";

type TextParamUpdater = (
  key: string,
  event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  transform?: (value: string) => unknown
) => void;

export function PromptLibraryNodeParams({
  params,
  promptLibrary,
  promptStatusFilter,
  onRefreshPromptLibrary,
  onPromptStatusFilterChange,
  onPromptContextMenu,
  onChange,
  updateTextParam
}: {
  params: Record<string, unknown>;
  promptLibrary: PromptLibraryData;
  promptStatusFilter: PromptStatusFilter;
  onRefreshPromptLibrary?: () => void;
  onPromptStatusFilterChange?: (filter: PromptStatusFilter) => void;
  onPromptContextMenu?: (event: MouseEvent, prompt: PromptLibraryPrompt) => void;
  onChange: (patch: Record<string, unknown>) => void;
  updateTextParam: TextParamUpdater;
}) {
  const categories = filterPromptLibraryByStatus(promptLibrary, promptStatusFilter).categories;
  const selectedCategory = categories.find((category) => category.id === String(params.category ?? "")) ?? categories[0];
  const prompts = selectedCategory?.prompts ?? [];
  const selectedPromptId = String(params.promptId ?? "");
  const selectedPrompt = prompts.find((prompt) => prompt.id === selectedPromptId);
  const displayPrompt = selectedPrompt ?? prompts[0];
  const mode = String(params.mode ?? "linked") === "embedded" ? "embedded" : "linked";
  const previewText = mode === "embedded" ? String(params.embeddedText ?? "") : displayPrompt?.text ?? "";
  if (categories.length === 0) {
    return (
      <div className="assetParams">
        <div className="nodeWarning">{promptLibrary.categories.length === 0 ? "No prompts found. Add .prompt.png or .prompt.md files to data/prompt-library/ and refresh." : "No prompts match the selected status filter."}</div>
        <label className="nodeField">
          <span>status</span>
          <select
            className="nodrag nopan nodeInput nodeSelect"
            value={promptStatusFilter}
            onChange={(event) => onPromptStatusFilterChange?.(event.target.value as PromptStatusFilter)}
          >
            {promptStatusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
        </label>
        <button className="nodeSmallButton nodrag nopan" type="button" onClick={onRefreshPromptLibrary}>Refresh Prompt Library</button>
      </div>
    );
  }
  return (
    <>
      <button className="nodeSmallButton nodrag nopan" type="button" onClick={onRefreshPromptLibrary}>Refresh Prompt Library</button>
      <label className="nodeField">
        <span>status</span>
        <select
          className="nodrag nopan nodeInput nodeSelect"
          value={promptStatusFilter}
          onChange={(event) => onPromptStatusFilterChange?.(event.target.value as PromptStatusFilter)}
        >
          {promptStatusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
        </select>
      </label>
      <label className="nodeField">
        <span>category</span>
        <select
          className="nodrag nopan nodeInput nodeSelect"
          value={selectedCategory?.id ?? ""}
          onChange={(event) => {
            const category = categories.find((entry) => entry.id === event.target.value);
            onChange({ category: event.target.value, promptId: category?.prompts[0]?.id ?? "", mode });
          }}
        >
          {categories.map((category) => (
            <option key={category.id} value={category.id}>{category.title}</option>
          ))}
        </select>
      </label>
      <div className="nodePromptCards nowheel">
        {prompts.map((prompt) => (
          <PromptLibraryPromptCard
            key={prompt.id}
            prompt={prompt}
            selected={prompt.id === selectedPromptId && Boolean(selectedPrompt)}
            onSelect={() => onChange({ promptId: prompt.id, category: selectedCategory?.id ?? prompt.category ?? "", mode })}
            onContextMenu={(event) => onPromptContextMenu?.(event, prompt)}
          />
        ))}
      </div>
      {displayPrompt?.description ? <div className="nodeHint">{displayPrompt.description}</div> : null}
      {mode === "linked" && selectedPromptId && !selectedPrompt ? (
        <div className="nodeWarning">Linked prompt "{selectedCategory?.id ?? String(params.category ?? "")}/{selectedPromptId}" is not visible in this library view. Pick a prompt card to relink this node.</div>
      ) : null}
      <label className="nodeField">
        <span>mode</span>
        <select className="nodrag nopan nodeInput nodeSelect" value={mode} onChange={(event) => onChange({ mode: event.target.value })}>
          <option value="linked">linked</option>
          <option value="embedded">embedded</option>
        </select>
      </label>
      <button
        className="nodeSmallButton nodrag nopan"
        type="button"
        disabled={!displayPrompt}
        onClick={() => onChange({ mode: "embedded", embeddedTitle: displayPrompt?.title ?? "", embeddedText: displayPrompt?.text ?? "" })}
      >
        Embed selected prompt
      </button>
      <label className="nodeField">
        <span>preview</span>
        <textarea
          className="nodrag nopan nodeTextarea outputTextArea"
          value={previewText}
          readOnly={mode === "linked"}
          onChange={(event) => updateTextParam("embeddedText", event)}
        />
      </label>
    </>
  );
}

function PromptLibraryPromptCard({
  prompt,
  selected,
  onSelect,
  onContextMenu
}: {
  prompt: PromptLibraryPrompt;
  selected: boolean;
  onSelect: () => void;
  onContextMenu?: (event: MouseEvent) => void;
}) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const previewSrc = prompt.previewImage && !previewFailed ? promptPreviewSrc(prompt) : "";
  return (
    <button
      className={`nodePromptCard nodrag nopan ${previewSrc ? "withPreview" : ""} ${selected ? "selected" : ""}`}
      type="button"
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu?.(event);
      }}
      title="Right-click for prompt actions"
    >
      {previewSrc ? <img src={previewSrc} alt="" onError={() => setPreviewFailed(true)} /> : null}
      <div className="nodePromptCardHeader">
        <strong>{prompt.title}</strong>
        <span className={`promptStatusBadge ${prompt.status ?? "published"}`}>{prompt.status ?? "published"}</span>
      </div>
      {prompt.description ? <span>{truncateText(prompt.description, 80)}</span> : null}
    </button>
  );
}

function filterPromptLibraryByStatus(library: PromptLibraryData, filter: PromptStatusFilter): PromptLibraryData {
  if (filter === "all") return library;
  return {
    ...library,
    categories: library.categories
      .map((category) => ({
        ...category,
        prompts: category.prompts.filter((prompt) => (prompt.status ?? "published") === filter)
      }))
      .filter((category) => category.prompts.length > 0)
  };
}

function promptPreviewSrc(prompt: PromptLibraryPrompt): string {
  const previewImage = prompt.previewImage ?? "";
  if (/^https?:\/\//i.test(previewImage)) return previewImage;
  const promptPath = prompt.path ?? "";
  const separatorIndex = Math.max(promptPath.lastIndexOf("/"), promptPath.lastIndexOf("\\"));
  const directory = separatorIndex >= 0 ? promptPath.slice(0, separatorIndex + 1) : "";
  return `${apiBase}/api/assets/preview?path=${encodeURIComponent(`${directory}${previewImage}`)}`;
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
