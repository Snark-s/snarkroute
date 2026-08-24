import type React from "react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { normalizeDialogueWorkbenchState, type ModelProfile } from "@snarkroute/protocol";
import { creditPriceExplanation, formatEstimatedCreditsLabel } from "../../shared/costFormatting";
import { useImageDimensions } from "../../shared/mediaPreview";
import { modelLogoFor } from "../../modelLogos";
import { GEMINI_LLM_MODEL_OPTIONS, POLZA_IMAGE_ASPECT_RATIOS, POLZA_IMAGE_FORMATS, POLZA_IMAGE_QUALITIES, POLZA_IMAGE_RESOLUTIONS, POLZA_VIDEO_DURATIONS, POLZA_VIDEO_RESOLUTIONS } from "../../studioConfig";
import { AssetNodeParams } from "./AssetNodeParams";
import { HttpRequestParams } from "./HttpRequestParams";
import { GenericManifestParams } from "./ParamRows";
import { TextNodeParams, isTextNodeParamsType } from "./TextNodeParams";
import { FisheyeTransformParams, ImageResizeTransformParams } from "./TransformNodeParams";
import { numericParam, restorePendingTextSelection, updateTextFieldPreservingCaret } from "./paramHelpers";
import { PromptLibraryNodeParams } from "../prompt-library/PromptLibraryNodeParams";
import { ModelSelectWithLogo } from "../model-catalog/ModelViews";
import { connectionRouteHelper, enrichImageGenerationModelOptions, enrichPolzaImageModelOptions, geminiLlmPricingLabel, imageAspectRatioOptions, imageGenerationModelOptions, imageModelCostLabel, imageModelOptionLabel, imageModelOptionLogo, imageModelOptionsFromNodeOptions, imageRoutePreview, imageSizeOptionsForModel, llmModelOptionLabel, modelOptionForNodeLabel, modelOptionForNodeLogo, modelSupportsText, openRouterCostLabel, openRouterModelSupportsVisionInput, polzaImageModelLogo, polzaModelHint, polzaModelSupportsVisionInput, polzaModelsFromNodeOptions, polzaProviderModelId, polzaVideoSupportsAudio, providerRouteOptionLabel, providerRouteSelectionKey, supportedOptionValue, videoModelHint, videoModelOptionKey, videoModelOptionsFromNodeOptions } from "../model-catalog/modelOptionUtils";
import type { AssetKind, CostEstimate, ImageViewerState, ModelOptionForNodeV1, ModelQuotePreview, NodeManifest, OpenRouterModel, PendingTextSelection, PolzaModel, PromptLibraryData, PromptLibraryPrompt, PromptStatusFilter, StableDiffusionModel, UnifiedModelInfo } from "../../studioTypes";

export type ChooseCameraPointParamsRenderProps = {
  params: Record<string, unknown>;
  inputImage?: unknown;
  onConfigureWorldLabs?: () => void;
  onPublishNodeOutput?: (output: Record<string, unknown>) => void;
  onChange: (patch: Record<string, unknown>) => void;
  onOpenImage?: (image: ImageViewerState) => void;
};

export function NodeParamsController({
  type,
  manifest,
  params,
  connectedInputPorts,
  promptLibrary,
  onRefreshPromptLibrary,
  promptStatusFilter,
  onPromptStatusFilterChange,
  onPromptContextMenu,
  stableDiffusionModels,
  openRouterModels,
  catalogImageModels,
  modelOptionsForNodes,
  polzaTextModels,
  polzaImageModels,
  polzaVideoModels,
  quotePreview,
  costEstimate,
  resizeInputImage,
  chooseCameraInputImage,
  onConfigureWorldLabs,
  onPublishNodeOutput,
  onRefreshPricing,
  modelProfiles,
  onRefreshStableDiffusionModels,
  onChange,
  onBrowse,
  canBrowseLocalFiles,
  onOpenImage,
  renderChooseCameraPointParams
}: {
  type: string;
  manifest?: NodeManifest;
  params: Record<string, unknown>;
  connectedInputPorts: Set<string>;
  promptLibrary: PromptLibraryData;
  onRefreshPromptLibrary?: () => void;
  promptStatusFilter: PromptStatusFilter;
  onPromptStatusFilterChange?: (filter: PromptStatusFilter) => void;
  onPromptContextMenu?: (event: React.MouseEvent, prompt: PromptLibraryPrompt) => void;
  stableDiffusionModels: StableDiffusionModel[];
  openRouterModels: OpenRouterModel[];
  catalogImageModels: UnifiedModelInfo[] | null;
  modelOptionsForNodes: Record<string, ModelOptionForNodeV1[] | undefined>;
  polzaTextModels: PolzaModel[];
  polzaImageModels: PolzaModel[];
  polzaVideoModels: PolzaModel[];
  quotePreview?: ModelQuotePreview;
  costEstimate?: CostEstimate;
  resizeInputImage?: unknown;
  chooseCameraInputImage?: unknown;
  onConfigureWorldLabs?: () => void;
  onPublishNodeOutput?: (output: Record<string, unknown>) => void;
  onRefreshPricing?: (provider: string) => void;
  modelProfiles: ModelProfile[];
  onRefreshStableDiffusionModels?: (endpoint: string) => void;
  onChange: (patch: Record<string, unknown>) => void;
  onBrowse: (kind: AssetKind) => void;
  canBrowseLocalFiles: boolean;
  onOpenImage?: (image: ImageViewerState) => void;
  renderChooseCameraPointParams?: (props: ChooseCameraPointParamsRenderProps) => React.ReactNode;
}) {
  const pendingTextSelectionRef = useRef<PendingTextSelection | null>(null);
  const resizeInputDimensions = useImageDimensions(type === "transform.imageResize" ? resizeInputImage : undefined);
  const modelCreditBadge = <ModelCreditBadge costEstimate={costEstimate} />;

  useEffect(() => {
    if (type !== "polza.video.generate") return;
    const model = String(params.model ?? "");
    if (!isPolzaVideoUpscaleModelId(model)) return;
    const replacementModel = modelOptionsForNodes["polza.video.generate"]?.find((entry) =>
      entry.provider === "polza" && entry.executionProvider === "polza" && !entry.roles.includes("upscaler")
    )?.storedModelId;
    if (replacementModel) onChange({ model: replacementModel, executionProvider: "polza" });
  }, [type, params.model, modelOptionsForNodes, onChange]);

  useLayoutEffect(() => {
    restorePendingTextSelection(pendingTextSelectionRef);
  }, [params]);

  function updateTextParam(key: string, event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>, transform: (value: string) => unknown = (value) => value) {
    updateTextFieldPreservingCaret(event, pendingTextSelectionRef, (value) => onChange({ [key]: transform(value) }));
  }

  if (isTextNodeParamsType(type)) {
    return <TextNodeParams type={type} params={params} onChange={onChange} updateTextParam={updateTextParam} />;
  }

  if (type === "transform.panorama360ToFisheye") {
    return <FisheyeTransformParams params={params} onChange={onChange} />;
  }

  if (type === "transform.chooseCameraPoint") {
    return renderChooseCameraPointParams?.({ params, inputImage: chooseCameraInputImage, onConfigureWorldLabs, onPublishNodeOutput, onChange, onOpenImage }) ?? null;
  }

  if (type === "transform.imageResize" && manifest?.params?.length) {
    return (
      <ImageResizeTransformParams
        manifest={manifest}
        params={params}
        dimensions={resizeInputDimensions.dimensions}
        status={resizeInputDimensions.status}
        onChange={onChange}
        updateTextParam={updateTextParam}
      />
    );
  }

  if (type === "library.prompt") {
    return (
      <PromptLibraryNodeParams
        params={params}
        promptLibrary={promptLibrary}
        promptStatusFilter={promptStatusFilter}
        onRefreshPromptLibrary={onRefreshPromptLibrary}
        onPromptStatusFilterChange={onPromptStatusFilterChange}
        onPromptContextMenu={onPromptContextMenu}
        onChange={onChange}
        updateTextParam={updateTextParam}
      />
    );
  }
  if (type === "input.file" || type === "input.image" || type === "input.video") {
    return (
      <AssetNodeParams
        type={type}
        params={params}
        canBrowseLocalFiles={canBrowseLocalFiles}
        onBrowse={onBrowse}
        onOpenImage={onOpenImage}
      />
    );
  }

  if (type === "replicate.model") {
    return (
      <>
        <label className="nodeField">
          <span className="nodeFieldTitle">model {modelCreditBadge}</span>
          <ModelSelectWithLogo logo={modelLogoFor("replicate", String(params.model ?? ""))}>
            <input className="nodrag nopan nodeInput" value={String(params.model ?? "")} onChange={(event) => updateTextParam("model", event)} />
          </ModelSelectWithLogo>
        </label>
        <label className="nodeField">
          <span>input</span>
          <textarea
            className="nodrag nopan nodeTextarea"
            value={JSON.stringify(params.input ?? {}, null, 2)}
            onChange={(event) => {
              updateTextFieldPreservingCaret(event, pendingTextSelectionRef, (value) => {
                try {
                  onChange({ input: JSON.parse(value) });
                } catch {
                  onChange({ input: value });
                }
              });
            }}
          />
        </label>
      </>
    );
  }

  if (type === "replicate.clarity-upscaler") {
    const promptConnected = connectedInputPorts.has("prompt");
    return (
      <>
        <label className="nodeField">
          <span>prompt</span>
          <textarea
            className={`nodrag nopan nodeTextarea ${promptConnected ? "nodeParamDisabled" : ""}`}
            value={String(params.prompt ?? "")}
            disabled={promptConnected}
            onChange={(event) => updateTextParam("prompt", event)}
          />
          {promptConnected ? <small className="nodeConnectedHint">Prompt comes from connected text input.</small> : null}
        </label>
        <label className="nodeField">
          <span>negative</span>
          <textarea className="nodrag nopan nodeTextarea compact" value={String(params.negative_prompt ?? "")} onChange={(event) => updateTextParam("negative_prompt", event)} />
        </label>
        <div className="nodeGridFields">
          {(["scale_factor", "dynamic", "creativity", "resemblance", "num_inference_steps", "seed"] as const).map((key) => (
            <label className="nodeField" key={key}>
              <span>{key}</span>
              <input
                className="nodrag nopan nodeInput"
                inputMode="decimal"
                value={String(params[key] ?? "").replace(".", ",")}
                onChange={(event) => updateTextParam(key, event, (value) => value.replace(".", ","))}
              />
            </label>
          ))}
        </div>
      </>
    );
  }

  if (type === "dialogue.workbench") {
    const state = normalizeDialogueWorkbenchState(params.state, {
      nodeId: "dialogue",
      defaultModelProfileId: String(params.defaultModelProfileId ?? "text.default")
    });
    const profile = modelProfiles.find((entry) => entry.id === (state.defaultModelProfileId ?? params.defaultModelProfileId));
    return (
      <div className="dialogueInlineSummary">
        <div><span>default model</span><strong>{profile?.displayName ?? String(params.defaultModelProfileId ?? "text.default")}</strong></div>
        <div><span>messages</span><strong>{state.messages.length}</strong></div>
        <div><span>selected outputs</span><strong>{state.selectedOutputs.length}</strong></div>
        <div className="nodeHint">Open the Workbench for messages, pins, outputs, and transcript exports.</div>
      </div>
    );
  }

  if (type === "ai.text") {
    const systemPromptConnected = connectedInputPorts.has("systemPrompt");
    const promptConnected = connectedInputPorts.has("prompt");
    const model = String(params.model ?? "text.default");
    const nodeModelOptions = modelOptionsForNodes["ai.text"] ?? [];
    const selectedNodeModel = nodeModelOptions.find((entry) => entry.id === model || entry.storedModelId === model || entry.providerRoutes?.some((route) => route.providerModelId === model || route.storedModelId === model));
    const providerRoutes = selectedNodeModel?.providerRoutes ?? [];
    const legacyRoute = providerRoutes.find((route) => route.providerModelId === model || route.storedModelId === model);
    const selectedProvider = String(params.executionProvider ?? params.provider ?? legacyRoute?.provider ?? providerRoutes[0]?.provider ?? selectedNodeModel?.executionProvider ?? "");
    const selectedRoute = providerRoutes.find((route) => route.provider === selectedProvider && (!params.providerModelId || route.providerModelId === params.providerModelId)) ?? providerRoutes.find((route) => route.provider === selectedProvider) ?? providerRoutes[0];
    const modelSelectValue = selectedNodeModel?.id ?? model;
    const reasoningOptions = selectedRoute?.parameters.find((parameter) => parameter.id === "reasoning_effort")?.options ?? [];
    return (
      <>
        <label className="nodeField">
          <span className="nodeFieldTitle">model {modelCreditBadge}</span>
          <ModelSelectWithLogo logo={modelOptionForNodeLogo(selectedNodeModel) ?? modelLogoFor("openrouter", model)}>
            <select className="nodrag nopan nodeInput nodeSelect" value={modelSelectValue} onChange={(event) => {
              const nextModel = event.target.value;
              const option = nodeModelOptions.find((entry) => entry.id === nextModel || entry.storedModelId === nextModel);
              const route = option?.providerRoutes?.[0];
              onChange({ model: option?.id ?? nextModel, providerModelId: route?.providerModelId ?? option?.providerModelId, provider: route?.provider ?? option?.executionProvider, executionProvider: route?.provider ?? option?.executionProvider, providerMode: option?.executionProvider === "rutronix" ? "rutronix" : undefined });
            }}>
              <option value="text.default">Auto / default text model</option>
              {(nodeModelOptions.length > 0
                ? nodeModelOptions.map((entry) => <option key={entry.id} value={entry.id}>{modelOptionForNodeLabel(entry)}</option>)
                : openRouterModels.filter((entry) => modelSupportsText(entry)).map((entry) => (
                  <option key={entry.id} value={entry.id}>{llmModelOptionLabel(entry.name ?? entry.id, entry.id, openRouterModelSupportsVisionInput(entry))}</option>
                ))
              )}
              {model && model !== "text.default" && !selectedNodeModel && !openRouterModels.some((entry) => entry.id === model) ? <option value={model}>{model}</option> : null}
            </select>
          </ModelSelectWithLogo>
          <small className="nodeConnectedHint">{openRouterCostLabel(openRouterModels.find((entry) => entry.id === model))}</small>
        </label>
        {providerRoutes.length > 1 ? <label className="nodeField"><span>provider route</span><select className="nodrag nopan nodeInput nodeSelect" value={providerRouteSelectionKey(selectedRoute)} onChange={(event) => { const route = providerRoutes.find((entry) => providerRouteSelectionKey(entry) === event.target.value); if (route) onChange({ model: selectedNodeModel?.id ?? model, provider: route.provider, executionProvider: route.provider, providerModelId: route.providerModelId, providerMode: undefined }); }}>
          {providerRoutes.map((route) => <option key={providerRouteSelectionKey(route)} value={providerRouteSelectionKey(route)}>{providerRouteOptionLabel(route, providerRoutes)}</option>)}
        </select></label> : null}
        <label className="nodeField">
          <span>system prompt</span>
          <textarea className={`nodrag nopan nodeTextarea ${systemPromptConnected ? "nodeParamDisabled" : ""}`} value={String(params.systemPrompt ?? "")} disabled={systemPromptConnected} onChange={(event) => updateTextParam("systemPrompt", event)} />
        </label>
        <label className="nodeField">
          <span>prompt</span>
          <textarea className={`nodrag nopan nodeTextarea ${promptConnected ? "nodeParamDisabled" : ""}`} value={String(params.prompt ?? "")} disabled={promptConnected} onChange={(event) => updateTextParam("prompt", event)} />
        </label>
        <details className="nodeAdvanced">
          <summary>Advanced</summary>
          {providerRoutes.length === 0 ? <label className="nodeField">
            <span>provider mode</span>
            <select className="nodrag nopan nodeInput nodeSelect" value={String(params.providerMode ?? "auto")} onChange={(event) => onChange({ providerMode: event.target.value })}>
              <option value="auto">Auto</option>
              <option value="openrouter">OpenRouter</option>
              <option value="rutronix">RuTronix</option>
              <option value="direct">Direct</option>
            </select>
          </label> : null}
          {reasoningOptions.length > 0 ? <label className="nodeField"><span>reasoning effort</span><select className="nodrag nopan nodeInput nodeSelect" value={String(params.reasoning_effort ?? reasoningOptions[0]?.value ?? "medium")} onChange={(event) => onChange({ reasoning_effort: event.target.value })}>{reasoningOptions.map((option) => <option key={option.value} value={option.value}>{option.label ?? option.value}</option>)}</select></label> : null}
          <div className="nodeGridFields">
            <label className="nodeField"><span>temperature</span><input className="nodrag nopan nodeInput" inputMode="decimal" value={String(params.temperature ?? "")} onChange={(event) => updateTextParam("temperature", event, numericParam)} /></label>
            <label className="nodeField"><span>max tokens</span><input className="nodrag nopan nodeInput" inputMode="numeric" value={String(params.max_tokens ?? "")} onChange={(event) => updateTextParam("max_tokens", event, numericParam)} /></label>
          </div>
        </details>
      </>
    );
  }

  if (type === "ai.image.generate") {
    const promptConnected = connectedInputPorts.has("prompt");
    const model = String(params.model ?? "image.nano-banana");
    const nodeModelOptions = modelOptionsForNodes["ai.image.generate"] ?? [];
    const modelOptions = nodeModelOptions.length > 0
      ? imageModelOptionsFromNodeOptions(nodeModelOptions, model)
      : enrichImageGenerationModelOptions(imageGenerationModelOptions(openRouterModels, model), catalogImageModels ?? []);
    const selectedNodeModel = nodeModelOptions.find((entry) => entry.id === model || entry.storedModelId === model || entry.providerRoutes?.some((route) => route.storedModelId === model || route.providerModelId === model));
    const providerRoutes = selectedNodeModel?.providerRoutes ?? [];
    const selectedProvider = String(params.executionProvider ?? params.provider ?? providerRoutes[0]?.provider ?? selectedNodeModel?.executionProvider ?? "");
    const selectedRoute = providerRoutes.find((route) => route.provider === selectedProvider && (!params.providerModelId || route.providerModelId === params.providerModelId)) ?? providerRoutes.find((route) => route.provider === selectedProvider) ?? providerRoutes[0];
    const baseSelectedModel = modelOptions.find((entry) => entry.id === model || entry.catalogModelId === selectedNodeModel?.id);
    const selectedModel = baseSelectedModel && selectedRoute ? { ...baseSelectedModel, slug: selectedRoute.providerModelId, provider: selectedRoute.provider, executionProvider: selectedRoute.provider, parameters: selectedRoute.parameters, pricing: selectedRoute.pricing, catalogProviderModelId: selectedRoute.providerModelId } : baseSelectedModel;
    const connectionRoute = imageConnectionRouteFromParams(params, selectedModel);
    const aspectRatioOptions = imageAspectRatioOptions(selectedModel);
    const imageSizeOptions = imageSizeOptionsForModel(selectedModel);
    const aspectRatio = typeof params.aspectRatio === "string" && params.aspectRatio.trim() ? params.aspectRatio : supportedOptionValue(params.aspectRatio, aspectRatioOptions);
    const visibleAspectRatioOptions = aspectRatio && !aspectRatioOptions.includes(aspectRatio) ? [aspectRatio, ...aspectRatioOptions] : aspectRatioOptions;
    const imageSize = supportedOptionValue(params.imageSize, imageSizeOptions);
    const routePreview = imageRoutePreview(selectedModel, connectionRoute);
    return (
      <>
        <label className="nodeField">
          <span className="nodeFieldTitle">model {modelCreditBadge}</span>
          <ModelSelectWithLogo logo={imageModelOptionLogo(selectedModel, model)}>
            <select
              className="nodrag nopan nodeInput nodeSelect"
              value={model}
              onChange={(event) => {
                const nextModel = modelOptions.find((entry) => entry.id === event.target.value);
                const nextNodeModel = nodeModelOptions.find((entry) => entry.id === nextModel?.catalogModelId || entry.storedModelId === event.target.value);
                const nextRoute = nextNodeModel?.providerRoutes?.[0];
                const nextImageSizes = imageSizeOptionsForModel(nextModel);
                onChange({
                  model: event.target.value,
                  ...(nextRoute ? { provider: nextRoute.provider, executionProvider: nextRoute.provider, providerModelId: nextRoute.providerModelId } : imageRouteParamsForModel(nextModel)),
                  imageSize: supportedOptionValue(params.imageSize, nextImageSizes)
                });
              }}
            >
              {modelOptions.map((entry) => (
                <option key={entry.id} value={entry.id} disabled={entry.disabled}>{imageModelOptionLabel(entry)}</option>
              ))}
            </select>
          </ModelSelectWithLogo>
          <small className="nodeConnectedHint">{imageModelCostLabel(selectedModel)}</small>
        </label>
        {providerRoutes.length > 1 ? <label className="nodeField"><span>provider route</span><select className="nodrag nopan nodeInput nodeSelect" value={providerRouteSelectionKey(selectedRoute)} onChange={(event) => { const route = providerRoutes.find((entry) => providerRouteSelectionKey(entry) === event.target.value); if (route) onChange({ model: selectedNodeModel?.id ?? model, provider: route.provider, executionProvider: route.provider, providerModelId: route.providerModelId, providerMode: undefined }); }}>
          {providerRoutes.map((route) => <option key={providerRouteSelectionKey(route)} value={providerRouteSelectionKey(route)}>{providerRouteOptionLabel(route, providerRoutes)}</option>)}
        </select></label> : null}
        <label className="nodeField">
          <span>prompt</span>
          <textarea className={`nodrag nopan nodeTextarea ${promptConnected ? "nodeParamDisabled" : ""}`} value={String(params.prompt ?? "")} disabled={promptConnected} onChange={(event) => updateTextParam("prompt", event)} />
        </label>
        <div className="nodeGridFields">
          <label className="nodeField">
            <span>aspect ratio</span>
            <select className="nodrag nopan nodeInput nodeSelect" value={aspectRatio} onChange={(event) => onChange({ aspectRatio: event.target.value })}>
              {visibleAspectRatioOptions.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="nodeField">
            <span>quality</span>
            <select className="nodrag nopan nodeInput nodeSelect" value={imageSize} onChange={(event) => onChange({ imageSize: event.target.value })}>
              {imageSizeOptions.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
        {!providerRoutes.length ? <details className="nodeAdvanced">
          <summary>Advanced</summary>
          <label className="nodeField">
            <span>Connection route</span>
            <select className="nodrag nopan nodeInput nodeSelect" value={connectionRoute} onChange={(event) => onChange(imageRouteParamsForConnectionRoute(event.target.value))}>
              <option value="auto">Auto</option>
              <option value="openrouter">OpenRouter</option>
              <option value="direct">Direct API</option>
            </select>
            <small className="nodeConnectedHint">{connectionRouteHelper(connectionRoute)}</small>
          </label>
          <div className="nodeRoutePreview">
            <div><span>Selected model</span><strong>{routePreview.selectedModelLabel}</strong></div>
            <div><span>Model slug</span><strong>{routePreview.selectedModelId}</strong></div>
            <div><span>Connection route</span><strong>{routePreview.selectedConnectionRoute}</strong></div>
            <div><span>Resolved provider</span><strong>{routePreview.resolvedProvider}</strong></div>
            <div><span>Resolved route</span><strong>{routePreview.resolvedRoute}</strong></div>
            <div><span>Image support</span><strong>{routePreview.supportsImageGeneration}</strong></div>
            <div><span>Fallback</span><strong>{routePreview.fallbackUsed ? "yes" : "no"}</strong></div>
            {routePreview.fallbackReason ? <div><span>Fallback reason</span><strong>{routePreview.fallbackReason}</strong></div> : null}
          </div>
        </details> : null}
      </>
    );
  }

  if (type === "polza.text") {
    const systemPromptConnected = connectedInputPorts.has("systemPrompt");
    const promptConnected = connectedInputPorts.has("prompt");
    const model = String(params.model ?? "");
    const nodeModelOptions = modelOptionsForNodes["polza.text"] ?? [];
    const modelOptions = polzaModelsFromNodeOptions(nodeModelOptions, model);
    const selectedModel = modelOptions.find((entry) => entry.id === model);
    return (
      <>
        <label className="nodeField">
          <span className="nodeFieldTitle">model {modelCreditBadge}</span>
          <ModelSelectWithLogo logo={modelLogoFor("polza", selectedModel?.id ?? model)}>
            <select className="nodrag nopan nodeInput nodeSelect" value={model} onChange={(event) => onChange({ model: event.target.value })}>
              {modelOptions.length === 0 ? <option value="" disabled>Model catalog unavailable</option> : null}
              {modelOptions.map((entry) => (
                <option key={entry.id} value={entry.id}>{llmModelOptionLabel(entry.name ?? entry.id, entry.id, polzaModelSupportsVisionInput(entry))}</option>
              ))}
            </select>
          </ModelSelectWithLogo>
          <small className="nodeConnectedHint">{polzaModelHint(selectedModel, "Text model via Polza.ai")}</small>
        </label>
        <label className="nodeField">
          <span>system prompt</span>
          <textarea className={`nodrag nopan nodeTextarea ${systemPromptConnected ? "nodeParamDisabled" : ""}`} value={String(params.systemPrompt ?? "")} disabled={systemPromptConnected} onChange={(event) => updateTextParam("systemPrompt", event)} />
          {systemPromptConnected ? <small className="nodeConnectedHint">System prompt comes from connected text input.</small> : null}
        </label>
        <label className="nodeField">
          <span>prompt</span>
          <textarea className={`nodrag nopan nodeTextarea ${promptConnected ? "nodeParamDisabled" : ""}`} value={String(params.prompt ?? "")} disabled={promptConnected} onChange={(event) => updateTextParam("prompt", event)} />
          {promptConnected ? <small className="nodeConnectedHint">Prompt comes from connected text input.</small> : null}
        </label>
        <details className="nodeAdvanced">
          <summary>Advanced</summary>
          <div className="nodeGridFields">
            <label className="nodeField"><span>temperature</span><input className="nodrag nopan nodeInput" inputMode="decimal" value={String(params.temperature ?? "")} onChange={(event) => updateTextParam("temperature", event, numericParam)} /></label>
            <label className="nodeField"><span>max tokens</span><input className="nodrag nopan nodeInput" inputMode="numeric" value={String(params.max_tokens ?? "")} onChange={(event) => updateTextParam("max_tokens", event, numericParam)} /></label>
          </div>
        </details>
      </>
    );
  }

  if (type === "polza.image.generate") {
    const promptConnected = connectedInputPorts.has("prompt");
    const model = polzaProviderModelId(String(params.model ?? ""));
    const nodeModelOptions = modelOptionsForNodes["polza.image.generate"] ?? [];
    const modelOptions = enrichPolzaImageModelOptions(polzaModelsFromNodeOptions(nodeModelOptions, model), catalogImageModels ?? []);
    const selectedModel = modelOptions.find((entry) => entry.id === model);
    const selectedModelId = selectedModel?.id ?? model;
    const aspectRatio = supportedOptionValue(params.aspectRatio, POLZA_IMAGE_ASPECT_RATIOS);
    const imageResolution = supportedOptionValue(params.imageResolution ?? params.imageSize, POLZA_IMAGE_RESOLUTIONS);
    const quality = supportedOptionValue(params.quality, POLZA_IMAGE_QUALITIES);
    const outputFormat = supportedOptionValue(params.outputFormat, POLZA_IMAGE_FORMATS);
    return (
      <>
        <label className="nodeField">
          <span className="nodeFieldTitle">model {modelCreditBadge}</span>
          <ModelSelectWithLogo logo={polzaImageModelLogo(selectedModel, model)}>
            <select className="nodrag nopan nodeInput nodeSelect" value={selectedModelId} onChange={(event) => onChange({ model: event.target.value })}>
              {modelOptions.length === 0 ? <option value="" disabled>Model catalog unavailable</option> : null}
              {modelOptions.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.name ? `${entry.name} (${entry.id})` : entry.id}</option>
              ))}
            </select>
          </ModelSelectWithLogo>
          <small className="nodeConnectedHint">{polzaModelHint(selectedModel, "Image model via Polza.ai")}</small>
        </label>
        <label className="nodeField">
          <span>prompt</span>
          <textarea className={`nodrag nopan nodeTextarea ${promptConnected ? "nodeParamDisabled" : ""}`} value={String(params.prompt ?? "")} disabled={promptConnected} onChange={(event) => updateTextParam("prompt", event)} />
          {promptConnected ? <small className="nodeConnectedHint">Prompt comes from connected text input.</small> : null}
        </label>
        <div className="nodeGridFields">
          <label className="nodeField">
            <span>aspect ratio</span>
            <select className="nodrag nopan nodeInput nodeSelect" value={aspectRatio} onChange={(event) => onChange({ aspectRatio: event.target.value })}>
              {POLZA_IMAGE_ASPECT_RATIOS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="nodeField">
            <span>resolution</span>
            <select className="nodrag nopan nodeInput nodeSelect" value={imageResolution} onChange={(event) => onChange({ imageResolution: event.target.value })}>
              {POLZA_IMAGE_RESOLUTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
        <details className="nodeAdvanced">
          <summary>Advanced</summary>
          <div className="nodeGridFields">
            <label className="nodeField">
              <span>quality</span>
              <select className="nodrag nopan nodeInput nodeSelect" value={quality} onChange={(event) => onChange({ quality: event.target.value })}>
                {POLZA_IMAGE_QUALITIES.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className="nodeField">
              <span>format</span>
              <select className="nodrag nopan nodeInput nodeSelect" value={outputFormat} onChange={(event) => onChange({ outputFormat: event.target.value })}>
                {POLZA_IMAGE_FORMATS.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
          </div>
        </details>
      </>
    );
  }

  if (type === "ai.video.generate") {
    const promptConnected = connectedInputPorts.has("prompt");
    const options = modelOptionsForNodes["ai.video.generate"] ?? [];
    const model = String(params.model ?? options[0]?.storedModelId ?? "");
    const selected = options.find((entry) => entry.id === model || entry.storedModelId === model || entry.providerRoutes?.some((route) => route.providerModelId === model || route.storedModelId === model)) ?? options[0];
    const routes = selected?.providerRoutes ?? [];
    const provider = String(params.executionProvider ?? params.provider ?? routes[0]?.provider ?? selected?.executionProvider ?? "");
    const route = routes.find((candidate) => candidate.provider === provider && (!params.providerModelId || candidate.providerModelId === params.providerModelId)) ?? routes.find((candidate) => candidate.provider === provider) ?? routes[0];
    const resolutions = routeParameterOptions(route?.parameters, "resolution", POLZA_VIDEO_RESOLUTIONS);
    const durations = routeParameterOptions(route?.parameters, "duration", POLZA_VIDEO_DURATIONS);
    return (
      <>
        <label className="nodeField">
          <span className="nodeFieldTitle">model {modelCreditBadge}</span>
          <ModelSelectWithLogo logo={modelOptionForNodeLogo(selected) ?? modelLogoFor(provider, model)}>
            <select className="nodrag nopan nodeInput nodeSelect" value={selected?.id ?? model} onChange={(event) => {
              const next = options.find((entry) => entry.id === event.target.value);
              const nextRoute = next?.providerRoutes?.[0];
              if (next) onChange({ model: next.id, provider: nextRoute?.provider ?? next.executionProvider, executionProvider: nextRoute?.provider ?? next.executionProvider, providerModelId: nextRoute?.providerModelId ?? next.providerModelId });
            }}>
              {options.length === 0 ? <option value="" disabled>Model catalog unavailable</option> : null}
              {options.map((entry) => <option key={entry.id} value={entry.id}>{modelOptionForNodeLabel(entry)}</option>)}
            </select>
          </ModelSelectWithLogo>
        </label>
        {routes.length > 1 ? <label className="nodeField"><span>provider route</span><select className="nodrag nopan nodeInput nodeSelect" value={providerRouteSelectionKey(route)} onChange={(event) => { const next = routes.find((candidate) => providerRouteSelectionKey(candidate) === event.target.value); if (next) onChange({ provider: next.provider, executionProvider: next.provider, providerModelId: next.providerModelId }); }}>{routes.map((candidate) => <option key={providerRouteSelectionKey(candidate)} value={providerRouteSelectionKey(candidate)}>{providerRouteOptionLabel(candidate, routes)}</option>)}</select></label> : null}
        <label className="nodeField"><span>prompt</span><textarea className={`nodrag nopan nodeTextarea ${promptConnected ? "nodeParamDisabled" : ""}`} value={String(params.prompt ?? "")} disabled={promptConnected} onChange={(event) => updateTextParam("prompt", event)} /></label>
        <div className="nodeGridFields">
          <label className="nodeField"><span>resolution</span><select className="nodrag nopan nodeInput nodeSelect" value={supportedOptionValue(params.resolution, resolutions)} onChange={(event) => onChange({ resolution: event.target.value })}>{resolutions.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label className="nodeField"><span>duration</span><select className="nodrag nopan nodeInput nodeSelect" value={supportedOptionValue(params.duration, durations)} onChange={(event) => onChange({ duration: event.target.value })}>{durations.map((value) => <option key={value} value={value}>{value}s</option>)}</select></label>
        </div>
        {route?.capabilities.includes("video.generate") && route.constraints?.audio ? <label className="nodeCheckField"><input className="nodrag nopan" type="checkbox" checked={params.sound !== false} onChange={(event) => onChange({ sound: event.target.checked })} /><span>sound</span></label> : null}
      </>
    );
  }

  if (type === "polza.video.generate") {
    const promptConnected = connectedInputPorts.has("prompt");
    const model = isPolzaVideoUpscaleModelId(String(params.model ?? "")) ? "" : String(params.model ?? "");
    const executionProvider = String(params.executionProvider ?? "polza") === "openrouter" ? "openrouter" : "polza";
    const nodeModelOptions = modelOptionsForNodes["polza.video.generate"] ?? [];
    const modelOptions = videoModelOptionsFromNodeOptions(nodeModelOptions, model);
    const selectedModel = modelOptions.find((entry) => entry.id === model && entry.providerId === executionProvider) ?? modelOptions.find((entry) => entry.id === model);
    const selectedModelKey = selectedModel ? videoModelOptionKey(selectedModel) : "";
    const resolution = supportedOptionValue(params.resolution, POLZA_VIDEO_RESOLUTIONS);
    const duration = supportedOptionValue(params.duration, POLZA_VIDEO_DURATIONS);
    const supportsAudio = polzaVideoSupportsAudio(selectedModel ?? { id: model });
    const generateAudio = params.generate_audio !== false;
    return (
      <>
        <label className="nodeField">
          <span className="nodeFieldTitle">model {modelCreditBadge}</span>
          <ModelSelectWithLogo logo={modelLogoFor(selectedModel?.providerId ?? "polza", selectedModel?.id ?? model)}>
            <select
              className="nodrag nopan nodeInput nodeSelect"
              value={selectedModelKey}
              onChange={(event) => {
                const nextModel = modelOptions.find((entry) => videoModelOptionKey(entry) === event.target.value);
                if (!nextModel) return;
                onChange({ model: nextModel.id, executionProvider: nextModel.providerId });
              }}
            >
              {modelOptions.length === 0 ? <option value="" disabled>Model catalog unavailable</option> : null}
              {modelOptions.map((entry) => (
                <option key={videoModelOptionKey(entry)} value={videoModelOptionKey(entry)}>{entry.name ? `${entry.name} (${entry.id}) - ${entry.providerLabel}` : `${entry.id} - ${entry.providerLabel}`}</option>
              ))}
            </select>
          </ModelSelectWithLogo>
          <small className="nodeConnectedHint">{videoModelHint(selectedModel, "Video model")}</small>
        </label>
        <label className="nodeField">
          <span>prompt</span>
          <textarea className={`nodrag nopan nodeTextarea ${promptConnected ? "nodeParamDisabled" : ""}`} value={String(params.prompt ?? "")} disabled={promptConnected} onChange={(event) => updateTextParam("prompt", event)} />
          {promptConnected ? <small className="nodeConnectedHint">Prompt comes from connected text input.</small> : null}
        </label>
        <div className="nodeGridFields">
          <label className="nodeField">
            <span>resolution</span>
            <select className="nodrag nopan nodeInput nodeSelect" value={resolution} onChange={(event) => onChange({ resolution: event.target.value })}>
              {POLZA_VIDEO_RESOLUTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="nodeField">
            <span>duration</span>
            <select className="nodrag nopan nodeInput nodeSelect" value={duration} onChange={(event) => onChange({ duration: event.target.value })}>
              {POLZA_VIDEO_DURATIONS.map((value) => <option key={value} value={value}>{value}s</option>)}
            </select>
          </label>
        </div>
        <details className="nodeAdvanced">
          <summary>Advanced</summary>
          {supportsAudio ? (
            <label className="nodeCheckField">
              <input className="nodrag nopan" type="checkbox" checked={generateAudio} onChange={(event) => onChange({ generate_audio: event.target.checked })} />
              <span>sound</span>
            </label>
          ) : null}
          <label className="nodeCheckField">
            <input className="nodrag nopan" type="checkbox" checked={Boolean(params.multi_shots)} onChange={(event) => onChange({ multi_shots: event.target.checked })} />
            <span>multi shots</span>
          </label>
        </details>
      </>
    );
  }

  if (type === "gemini.nano-banana-2") {
    const promptConnected = connectedInputPorts.has("prompt");
    return (
      <>
        <div className="nodeFixedModelLine">
          <span>model</span>
          <strong>gemini-3.1-flash-image-preview</strong>
          {modelCreditBadge}
        </div>
        <label className="nodeField">
          <span>prompt</span>
          <textarea
            className={`nodrag nopan nodeTextarea ${promptConnected ? "nodeParamDisabled" : ""}`}
            value={String(params.prompt ?? "")}
            disabled={promptConnected}
            onChange={(event) => updateTextParam("prompt", event)}
          />
          {promptConnected ? <small className="nodeConnectedHint">Prompt comes from connected text input.</small> : null}
        </label>
        <div className="nodeGridFields">
          <label className="nodeField">
            <span>aspect ratio</span>
            <select
              className="nodrag nopan nodeInput nodeSelect"
              value={String(params.aspectRatio ?? "1:1")}
              onChange={(event) => onChange({ aspectRatio: event.target.value })}
            >
              {["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"].map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="nodeField">
            <span>quality</span>
            <select
              className="nodrag nopan nodeInput nodeSelect"
              value={String(params.imageSize ?? "2K")}
              onChange={(event) => onChange({ imageSize: event.target.value })}
            >
              {["1K", "2K", "4K"].map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
        </div>
      </>
    );
  }

  if (type === "gemini.llm") {
    const systemPromptConnected = connectedInputPorts.has("systemPrompt");
    const promptConnected = connectedInputPorts.has("prompt");
    return (
      <>
        <label className="nodeField">
          <span>system prompt</span>
          <textarea
            className={`nodrag nopan nodeTextarea ${systemPromptConnected ? "nodeParamDisabled" : ""}`}
            value={String(params.systemPrompt ?? "")}
            disabled={systemPromptConnected}
            onChange={(event) => updateTextParam("systemPrompt", event)}
          />
          {systemPromptConnected ? <small className="nodeConnectedHint">System prompt comes from connected text input.</small> : null}
        </label>
        <label className="nodeField">
          <span>prompt</span>
          <textarea
            className={`nodrag nopan nodeTextarea ${promptConnected ? "nodeParamDisabled" : ""}`}
            value={String(params.prompt ?? "")}
            disabled={promptConnected}
            onChange={(event) => updateTextParam("prompt", event)}
          />
          {promptConnected ? <small className="nodeConnectedHint">Prompt comes from connected text input.</small> : null}
        </label>
        <label className="nodeField">
          <span className="nodeFieldTitle">model {modelCreditBadge}</span>
          <ModelSelectWithLogo logo={modelLogoFor("gemini", String(params.model ?? "gemini-2.5-flash-lite"))}>
            <select
              className="nodrag nopan nodeInput nodeSelect"
              value={String(params.model ?? "gemini-2.5-flash-lite")}
              onChange={(event) => onChange({ model: event.target.value })}
            >
              {GEMINI_LLM_MODEL_OPTIONS.map((model) => (
                <option key={model.value} value={model.value}>
                  {llmModelOptionLabel(model.label, model.value, model.supportsVision)}
                </option>
              ))}
            </select>
          </ModelSelectWithLogo>
          <small className="nodeConnectedHint">{geminiLlmPricingLabel(String(params.model ?? "gemini-2.5-flash-lite"))}</small>
        </label>
      </>
    );
  }

  if (type === "local.stableDiffusion.textToImage") {
    const promptConnected = connectedInputPorts.has("prompt");
    const negativeConnected = connectedInputPorts.has("negativePrompt");
    const endpoint = String(params.endpoint ?? "http://127.0.0.1:7860");
    const selectedModel = String(params.model ?? "");
    return (
      <>
        <label className="nodeField">
          <span>endpoint</span>
          <input className="nodrag nopan nodeInput" value={endpoint} onChange={(event) => updateTextParam("endpoint", event)} />
        </label>
        <label className="nodeField">
          <span>model</span>
          <ModelSelectWithLogo logo={modelLogoFor("local", selectedModel || "stable-diffusion")}>
            <select
              className="nodrag nopan nodeInput nodeSelect"
              value={selectedModel}
              onChange={(event) => onChange({ model: event.target.value })}
            >
              <option value="">current WebUI model</option>
              {stableDiffusionModels.map((model) => (
                <option key={model.title} value={model.title}>{model.title}</option>
              ))}
              {selectedModel && !stableDiffusionModels.some((model) => model.title === selectedModel) ? <option value={selectedModel}>{selectedModel}</option> : null}
            </select>
          </ModelSelectWithLogo>
          <small className="nodeConnectedHint">Sent as sd_model_checkpoint for this request.</small>
        </label>
        <button className="nodeSmallButton nodrag nopan" type="button" onClick={() => onRefreshStableDiffusionModels?.(endpoint)}>Refresh models</button>
        {stableDiffusionModels.length === 0 ? (
          <label className="nodeField">
            <span>manual model</span>
            <input className="nodrag nopan nodeInput" value={selectedModel} placeholder="Optional checkpoint title" onChange={(event) => updateTextParam("model", event)} />
          </label>
        ) : null}
        <label className="nodeField">
          <span>prompt</span>
          <textarea
            className={`nodrag nopan nodeTextarea ${promptConnected ? "nodeParamDisabled" : ""}`}
            value={String(params.prompt ?? "")}
            disabled={promptConnected}
            onChange={(event) => updateTextParam("prompt", event)}
          />
          {promptConnected ? <small className="nodeConnectedHint">Prompt comes from connected text input.</small> : null}
        </label>
        <label className="nodeField">
          <span>negative</span>
          <textarea
            className={`nodrag nopan nodeTextarea compact ${negativeConnected ? "nodeParamDisabled" : ""}`}
            value={String(params.negativePrompt ?? "")}
            disabled={negativeConnected}
            onChange={(event) => updateTextParam("negativePrompt", event)}
          />
        </label>
        <div className="nodeGridFields">
          {(["width", "height", "steps", "cfgScale", "batchSize", "seed"] as const).map((key) => (
            <label className="nodeField" key={key}>
              <span>{key}</span>
              <input className="nodrag nopan nodeInput" inputMode="decimal" value={String(params[key] ?? "")} onChange={(event) => updateTextParam(key, event)} />
            </label>
          ))}
        </div>
        <label className="nodeField">
          <span>sampler</span>
          <input className="nodrag nopan nodeInput" value={String(params.samplerName ?? "")} onChange={(event) => updateTextParam("samplerName", event)} />
        </label>
      </>
    );
  }

  if (type === "http.request") {
    return <HttpRequestParams params={params} onChange={onChange} updateTextParam={updateTextParam} />;
  }

  if ((type === "local_upscale" || type === "local_video_upscale") && manifest?.params?.length) {
    const modelOptions = modelOptionsForNodes[type] ?? [];
    const model = String(params.model ?? modelOptions[0]?.storedModelId ?? "");
    const selectedModel = modelOptions.find((option) => option.storedModelId === model || option.id === model);
    const remainingManifest = { ...manifest, params: manifest.params.filter((param) => param.id !== "model") };
    return (
      <>
        <label className="nodeField">
          <span className="nodeFieldTitle">Model</span>
          <ModelSelectWithLogo logo={modelOptionForNodeLogo(selectedModel) ?? modelLogoFor(type, model)}>
            <select className="nodrag nopan nodeInput nodeSelect" value={model} onChange={(event) => onChange({ model: event.target.value })}>
              {modelOptions.map((option) => (
                <option key={option.id} value={option.storedModelId}>{modelOptionForNodeLabel(option)}</option>
              ))}
              {model && !selectedModel ? <option value={model}>{model}</option> : null}
            </select>
          </ModelSelectWithLogo>
        </label>
        <GenericManifestParams manifest={remainingManifest} params={params} onChange={onChange} updateTextParam={updateTextParam} />
      </>
    );
  }

  if (manifest?.params?.length) {
    return <GenericManifestParams manifest={manifest} params={params} onChange={onChange} updateTextParam={updateTextParam} />;
  }

  return null;
}



function ModelCreditBadge({ costEstimate }: { costEstimate?: CostEstimate }) {
  if (!costEstimate || costEstimate.estimatedCredits <= 0) return null;
  return (
    <span className="modelCreditBadge" title={creditPriceExplanation(costEstimate)}>
      <span className="modelCreditDot" aria-hidden="true" />
      <span>{formatEstimatedCreditsLabel(costEstimate, costEstimate.estimatedCredits)}</span>
    </span>
  );
}

function imageConnectionRouteFromParams(params: Record<string, unknown>, selectedModel: { executionProvider?: string; routeSupport?: { openrouter: string; direct: string } } | undefined): string {
  const explicitRoute = String(params.providerMode ?? "");
  if (explicitRoute === "openrouter" || explicitRoute === "direct" || explicitRoute === "auto") return explicitRoute;
  const executionProvider = String(params.executionProvider ?? params.provider ?? params.providerId ?? selectedModel?.executionProvider ?? "");
  if (executionProvider === "openrouter") return "openrouter";
  if (executionProvider === "gemini") return "direct";
  if (selectedModel?.routeSupport?.openrouter === "supported") return "openrouter";
  if (selectedModel?.routeSupport?.direct === "supported") return "direct";
  return "auto";
}

function imageRouteParamsForModel(model: { executionProvider?: string; routeSupport?: { openrouter: string; direct: string } } | undefined): Record<string, unknown> {
  const executionProvider = model?.executionProvider;
  if (executionProvider === "openrouter") return { provider: "openrouter", executionProvider: "openrouter", providerMode: "openrouter" };
  if (executionProvider === "gemini") return { provider: "gemini", executionProvider: "gemini", providerMode: "direct" };
  if (model?.routeSupport?.openrouter === "supported") return { provider: "openrouter", executionProvider: "openrouter", providerMode: "openrouter" };
  if (model?.routeSupport?.direct === "supported") return { provider: "gemini", executionProvider: "gemini", providerMode: "direct" };
  return {};
}

function routeParameterOptions(parameters: Array<{ id: string; options?: Array<{ value: string }> }> | undefined, id: string, fallback: string[]): string[] {
  const values = parameters?.find((parameter) => parameter.id === id)?.options?.map((option) => String(option.value)).filter(Boolean);
  return values?.length ? values : fallback;
}

function imageRouteParamsForConnectionRoute(route: string): Record<string, unknown> {
  if (route === "openrouter") return { provider: "openrouter", executionProvider: "openrouter", providerMode: "openrouter" };
  if (route === "direct") return { provider: "gemini", executionProvider: "gemini", providerMode: "direct" };
  return { provider: undefined, executionProvider: undefined, providerMode: "auto" };
}


function isPolzaVideoUpscaleModelId(modelId: string | undefined): boolean {
  return /(^|\/)(video-)?upscale|upscaler|topaz/i.test(String(modelId ?? ""));
}

