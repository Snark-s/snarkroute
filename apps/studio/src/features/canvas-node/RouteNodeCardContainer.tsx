import { Handle, Position, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import { Aperture, BookOpen, Braces, Bug, ChevronDown, ChevronRight, ChevronUp, Cpu, Eraser, Eye, FileJson, FileText, Film, FolderOpen, Globe, ImageIcon, MessageSquareText, Save, Sparkles, Type, Video, Wand2 } from "lucide-react";
import React, { useLayoutEffect, useRef } from "react";
import { DEFAULT_MODEL_PROFILES, normalizeDialogueWorkbenchState, type DialogueOutputType, type ModelProfile } from "@snarkroute/protocol";
import { geminiTokenStatusText, replicateTokenStatusText } from "../../security-ui";
import { modelLogoFor } from "../../modelLogos";
import { filenameFromPath } from "../../shared/fileHelpers";
import { creditPriceExplanation, formatCredits, formatEstimatedCreditsLabel } from "../../shared/costFormatting";
import { imageLabel, imagePreviewSrc, lastImageValue, localImagePreviewSrc } from "../../shared/mediaPreview";
import { routeNodeParamsCollapsed } from "../route-io/routeFlow";
import { ModelLogoMark } from "../model-catalog/ModelViews";
import { RouteNodeRunActions } from "./RouteNodeActions";
import { CollapsedImagePreviewButton } from "./RouteNodePreview";
import { NodeParamsController } from "../node-params/NodeParamsController";
import { GEMINI_API_KEY_URL } from "../../studioConfig";
import type { AssetKind, CostEstimate, FixNodeOutputOptions, ImageViewerState, ModelOptionForNodeV1, ModelQuotePreview, NodeManifest, NodeRunResult, OpenRouterModel, PolzaModel, PortKind, PortSpec, PromptLibraryData, PromptLibraryPrompt, PromptStatusFilter, RouteDoc, StableDiffusionModel, UnifiedModelInfo } from "../../studioTypes";

export type RouteNodeInlineResultRenderProps = {
  nodeId: string;
  type: string;
  result: NodeRunResult;
  outputPinned?: boolean;
  onOpenImage?: (image: ImageViewerState) => void;
  onDownloadImage?: (src: string, filename: string) => void;
  onImageResultContextMenu?: (event: React.MouseEvent, nodeId: string, result: NodeRunResult) => void;
  onFixNodeOutput?: (nodeId: string, output: unknown, options?: FixNodeOutputOptions) => void;
  onConfigureMissingSecret?: () => void;
};

type NormalizedRouteNodeCardData = {
  title: string;
  type: string;
  routeNode?: RouteDoc["nodes"][number];
  params: Record<string, unknown>;
};

export function normalizeRouteNodeCardData(id: string, data: Record<string, unknown>): NormalizedRouteNodeCardData {
  const routeNode = isRecord(data.routeNode) ? data.routeNode as RouteDoc["nodes"][number] : undefined;
  const label = typeof data.label === "string" ? data.label : "";
  const [labelTitle = "", labelType = ""] = label.split("\n");
  const type = String(routeNode?.type ?? labelType);
  const title = String((routeNode?.title ?? labelTitle) || id);
  const params = isRecord(routeNode?.params) ? routeNode.params : {};
  return { title, type, routeNode, params };
}

export function RouteNodeCardContainer({ id, data }: NodeProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const updateNodeInternals = useUpdateNodeInternals();
  const { title, type, routeNode, params } = normalizeRouteNodeCardData(id, data as Record<string, unknown>);
  const paramsCollapsed = Boolean(data.paramsCollapsed ?? routeNodeParamsCollapsed(routeNode));
  const result = data.result as NodeRunResult | undefined;
  const onParamsChange = data.onParamsChange as ((nodeId: string, params: Record<string, unknown>) => void) | undefined;
  const onParamsCollapsedChange = data.onParamsCollapsedChange as ((nodeId: string, collapsed: boolean) => void) | undefined;
  const onBrowseAsset = data.onBrowseAsset as ((nodeId: string, kind: AssetKind) => void) | undefined;
  const supportsLocalFilesystem = data.supportsLocalFilesystem !== false;
  const replicateConfigured = Boolean(data.replicateConfigured);
  const geminiConfigured = Boolean(data.geminiConfigured);
  const openAiConfigured = Boolean(data.openAiConfigured);
  const seedanceConfigured = Boolean(data.seedanceConfigured);
  const seedanceStatusText = String(data.seedanceStatusText ?? "");
  const polzaConfigured = Boolean(data.polzaConfigured);
  const polzaKeyFingerprint = String(data.polzaKeyFingerprint ?? "");
  const openRouterConfigured = Boolean(data.openRouterConfigured);
  const onConfigureReplicate = data.onConfigureReplicate as (() => void) | undefined;
  const onConfigureGemini = data.onConfigureGemini as (() => void) | undefined;
  const onConfigureOpenAi = data.onConfigureOpenAi as (() => void) | undefined;
  const onConfigureSeedance = data.onConfigureSeedance as (() => void) | undefined;
  const onConfigureWorldLabs = data.onConfigureWorldLabs as (() => void) | undefined;
  const onConfigurePolza = data.onConfigurePolza as (() => void) | undefined;
  const onConfigureOpenRouter = data.onConfigureOpenRouter as (() => void) | undefined;
  const onOpenImage = data.onOpenImage as ((image: ImageViewerState) => void) | undefined;
  const onDownloadImage = data.onDownloadImage as ((src: string, filename: string) => void) | undefined;
  const onImageResultContextMenu = data.onImageResultContextMenu as ((event: React.MouseEvent, nodeId: string, result: NodeRunResult) => void) | undefined;
  const onFixNodeOutput = data.onFixNodeOutput as ((nodeId: string, output: unknown, options?: FixNodeOutputOptions) => void) | undefined;
  const renderInlineResult = data.renderInlineResult as ((props: RouteNodeInlineResultRenderProps) => React.ReactNode) | undefined;
  const onRunNodeOnly = data.onRunNodeOnly as ((nodeId: string) => void) | undefined;
  const onRunNodeWithDependencies = data.onRunNodeWithDependencies as ((nodeId: string) => void) | undefined;
  const onOpenSubroute = data.onOpenSubroute as ((nodeId: string) => void) | undefined;
  const onOpenDialogueWorkbench = data.onOpenDialogueWorkbench as ((nodeId: string) => void) | undefined;
  const onUncollapse = data.onUncollapse as ((nodeId: string) => void) | undefined;
  const onNodeUiChange = data.onNodeUiChange as ((nodeId: string, patch: Record<string, unknown>) => void) | undefined;
  const onPublishNodeOutput = data.onPublishNodeOutput as ((nodeId: string, output: Record<string, unknown>) => void) | undefined;
  const promptLibrary = data.promptLibrary as PromptLibraryData | undefined;
  const onRefreshPromptLibrary = data.onRefreshPromptLibrary as (() => void) | undefined;
  const promptStatusFilter = (data.promptStatusFilter as PromptStatusFilter | undefined) ?? "all";
  const onPromptStatusFilterChange = data.onPromptStatusFilterChange as ((filter: PromptStatusFilter) => void) | undefined;
  const onPromptContextMenu = data.onPromptContextMenu as ((event: React.MouseEvent, prompt: PromptLibraryPrompt) => void) | undefined;
  const stableDiffusionModels = (data.stableDiffusionModels as StableDiffusionModel[] | undefined) ?? [];
  const openRouterModels = (data.openRouterModels as OpenRouterModel[] | undefined) ?? [];
  const catalogImageModels = (data.catalogImageModels as UnifiedModelInfo[] | null | undefined) ?? null;
  const modelOptionsForNodes = (data.modelOptionsForNodes as Record<string, ModelOptionForNodeV1[] | undefined> | undefined) ?? {};
  const modelProfiles = (data.modelProfiles as ModelProfile[] | undefined) ?? DEFAULT_MODEL_PROFILES;
  const polzaTextModels = (data.polzaTextModels as PolzaModel[] | undefined) ?? [];
  const polzaImageModels = (data.polzaImageModels as PolzaModel[] | undefined) ?? [];
  const polzaVideoModels = (data.polzaVideoModels as PolzaModel[] | undefined) ?? [];
  const quotePreview = data.quotePreview as ModelQuotePreview | undefined;
  const costEstimate = data.costEstimate as CostEstimate | undefined;
  const resizeInputImage = data.resizeInputImage;
  const chooseCameraInputImage = data.chooseCameraInputImage;
  const renderChooseCameraPointParams = data.renderChooseCameraPointParams as React.ComponentProps<typeof NodeParamsController>["renderChooseCameraPointParams"];
  const manifest = data.manifest as NodeManifest | undefined;
  const isMissingNode = Boolean(data.isMissingNode);
  const onRefreshStableDiffusionModels = data.onRefreshStableDiffusionModels as ((endpoint: string) => void) | undefined;
  const onRefreshPricing = data.onRefreshPricing as ((provider: string) => void) | undefined;
  const connectedInputPorts = new Set((data.connectedInputPorts as string[] | undefined) ?? []);
  const connectedInputCounts = (data.connectedInputCounts as Record<string, number> | undefined) ?? {};
  const creditBalance = data.creditBalance as { balance: number; currency: string } | null | undefined;
  const canRunNodeOnly = Boolean(data.canRunNodeOnly);
  const nodeNeedsCredits = Math.max(0, Math.ceil(Number(costEstimate?.finalCredits ?? costEstimate?.estimatedCredits ?? 0)));
  const nodeHasEnoughCredits = !creditBalance || creditBalance.balance >= nodeNeedsCredits;
  const ports = getNodePorts(type, manifest, routeNode);
  const outputPinned = pinnedOutputFromParams(params) !== undefined;
  const collapsedInputImagePath = type === "input.image" ? String(params.path ?? "").trim() : "";
  const collapsedResultImage = result ? lastImageValue(result.output) : null;
  const collapsedImageSrc = paramsCollapsed
    ? collapsedInputImagePath
      ? localImagePreviewSrc(collapsedInputImagePath)
      : imagePreviewSrc(collapsedResultImage)
    : null;
  const collapsedImageTitle = collapsedImageSrc
    ? collapsedInputImagePath
      ? filenameFromPath(collapsedInputImagePath)
      : imageLabel(collapsedResultImage)
    : "";
  const collapsedImageFilename = collapsedInputImagePath ? filenameFromPath(collapsedInputImagePath) : downloadFilename(collapsedResultImage);
  const portTopBase = paramsCollapsed ? 14 : 34;
  const collapsedPortSpacing = 20;
  const collapsedPortCount = Math.max(ports.inputs.length, ports.outputs.length);
  const collapsedMinHeight = paramsCollapsed ? Math.max(44, 30 + Math.max(0, collapsedPortCount - 1) * collapsedPortSpacing) : undefined;

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;

    let animationFrame = 0;
    const updateHandles = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => updateNodeInternals(id));
    };
    const observer = new ResizeObserver(updateHandles);
    observer.observe(card);
    updateHandles();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  }, [id, updateNodeInternals, paramsCollapsed, ports.inputs.length, ports.outputs.length]);

  function portLabelTop(index: number): number {
    return paramsCollapsed ? portHandleTop(index, 1) : portTopBase + index * 28;
  }

  function portHandleTop(index: number, total: number): number {
    if (!paramsCollapsed) return portTopBase + 8 + index * 28;
    const count = Math.max(total, 1);
    const first = (collapsedMinHeight ?? 44) / 2 - ((count - 1) * collapsedPortSpacing) / 2;
    return first + index * collapsedPortSpacing;
  }

  function patchParams(patch: Record<string, unknown>) {
    onParamsChange?.(id, { ...params, ...patch });
  }

  const configureMissingSecret = configureHandlerForError(result?.error, {
    REPLICATE_API_TOKEN: onConfigureReplicate,
    GEMINI_API_KEY: onConfigureGemini,
    OPENAI_API_KEY: onConfigureOpenAi,
    POLZA_AI_API_KEY: onConfigurePolza,
    SEEDANCE_API_KEY: onConfigureSeedance,
    WORLDS_API_KEY: onConfigureWorldLabs
  });

  return (
    <div ref={cardRef} className={`routeNodeCard ${compactNodeClass(type)} ${paramsCollapsed ? "paramsCollapsed" : ""}`.trim()} style={collapsedMinHeight ? { minHeight: `${collapsedMinHeight}px` } : undefined}>
      <span className={`nodeStatus ${statusClass(result?.status)}`} />
      {isMissingNode ? <div className="nodeWarning">Missing block package. Install "{type}" or remove this block.</div> : null}
      {shouldShowNodeRunButton(type) ? (
        <RouteNodeRunActions
          nodeId={id}
          canRunNodeOnly={canRunNodeOnly}
          onRunNodeOnly={onRunNodeOnly}
          onRunNodeWithDependencies={onRunNodeWithDependencies}
        />
      ) : null}
      {ports.inputs.map((port, index) => (
        <React.Fragment key={port.id}>
          <span className="portLabel input" style={{ top: `${portLabelTop(index)}px` }}>
            {portLabel(port, connectedInputCounts[port.id] ?? 0)}
          </span>
          <Handle
            className={`typedHandle ${port.kind}`}
            id={port.id}
            type="target"
            position={Position.Left}
            style={{ top: `${portHandleTop(index, ports.inputs.length)}px` }}
            title={`${port.id}: ${port.kind}`}
          />
        </React.Fragment>
      ))}
      <div className="nodeHeader">
        <span className={`nodeIcon ${nodeIconClass(type)}`}>{nodeIcon(type)}</span>
        <div>
          <div className="nodeTitle">{title}</div>
          {!paramsCollapsed ? (
            <>
              <div className="nodeType" title={type}>{type}</div>
              <div className={`executorBadge ${executorKind(type, manifest)}`}>{executorLabel(type, manifest)}</div>
              {routeNode?.type === "compound.subroute" ? <div className="nodeMetaLine">{routeNode.subroute?.nodes.length ?? 0} internal block(s)</div> : null}
              {routeNode?.type === "dialogue.workbench" ? <DialogueNodeMeta routeNode={routeNode} modelProfiles={modelProfiles} /> : null}
            </>
          ) : null}
        </div>
        <button
          className="nodeCollapseButton nodrag nopan"
          type="button"
          title={paramsCollapsed ? "Show parameters" : "Hide parameters"}
          onClick={(event) => {
            event.stopPropagation();
            onParamsCollapsedChange?.(id, !paramsCollapsed);
          }}
        >
          {paramsCollapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>
        {paramsCollapsed && routeNode?.type === "compound.subroute" && (routeNode.subroute?.nodes.length ?? 0) > 0 ? (
          <button
            className="collapsedCompoundOpenButton nodrag nopan"
            type="button"
            title="Open Internal Tool Route"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onOpenSubroute?.(id);
            }}
          >
            <FolderOpen size={13} />
          </button>
        ) : null}
      </div>
      {!paramsCollapsed && isReplicateNode(type) ? (
        <div className={`nodeTokenStatus ${replicateConfigured ? "configured" : "missing"}`}>
          <span>{replicateTokenStatusText(replicateConfigured)}</span>
          {!replicateConfigured ? (
            <>
              <strong>Requires Replicate API token</strong>
              <button className="nodeSmallButton nodrag nopan" onClick={onConfigureReplicate}>Configure Replicate</button>
              <small>Open Settings \u2192 Secrets \u2192 Replicate</small>
            </>
          ) : null}
        </div>
      ) : null}
      {!paramsCollapsed && routeNode?.type === "compound.subroute" ? (
        <div className="compoundActions">
          <button
            className="nodeSmallButton nodrag nopan"
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onOpenSubroute?.(id);
            }}
          >
            Open Internal Tool Route
          </button>
          <button
            className="nodeSmallButton nodrag nopan"
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onUncollapse?.(id);
            }}
          >
            Uncollapse
          </button>
        </div>
      ) : null}
      {!paramsCollapsed && routeNode?.type === "dialogue.workbench" ? (
        <div className="compoundActions">
          <button
            className="nodeSmallButton nodrag nopan"
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onOpenDialogueWorkbench?.(id);
            }}
          >
            Open Workbench
          </button>
        </div>
      ) : null}
      {!paramsCollapsed && isGeminiNode(type) ? (
        <div className={`nodeTokenStatus ${geminiConfigured ? "configured" : "missing"}`}>
          <span>{geminiTokenStatusText(geminiConfigured)}</span>
          {!geminiConfigured ? (
            <>
              <strong>Requires Gemini API key</strong>
              <button className="nodeSmallButton nodrag nopan" onClick={onConfigureGemini}>Configure Gemini</button>
              <small>Open Settings \u2192 Secrets \u2192 Gemini</small>
              <a className="nodeTokenLink nodrag nopan" href={GEMINI_API_KEY_URL} target="_blank" rel="noreferrer">Get Gemini API key</a>
            </>
          ) : null}
        </div>
      ) : null}
      {!paramsCollapsed && requiresEnv(manifest, "OPENAI_API_KEY") ? (
        <div className={`nodeTokenStatus ${openAiConfigured ? "configured" : "missing"}`}>
          <span>OpenAI: {openAiConfigured ? "key configured" : "missing"}</span>
          {!openAiConfigured ? (
            <>
              <strong>Requires OpenAI API key</strong>
              <button className="nodeSmallButton nodrag nopan" onClick={onConfigureOpenAi}>Configure OpenAI</button>
              <small>Open Settings &gt; Advanced / Direct Secrets &gt; OpenAI</small>
            </>
          ) : null}
        </div>
      ) : null}
      {!paramsCollapsed && requiresEnv(manifest, "SEEDANCE_API_KEY") ? (
        <div className={`nodeTokenStatus ${seedanceConfigured ? "configured" : "missing"}`}>
          <span>Seedance: {seedanceConfigured ? "configured" : (seedanceStatusText || "missing")}</span>
          {!seedanceConfigured ? (
            <>
              <strong>Requires Seedance backend and API key</strong>
              <button className="nodeSmallButton nodrag nopan" onClick={onConfigureSeedance}>Configure Seedance</button>
              <small>Open Settings &gt; Advanced / Direct Secrets &gt; Seedance</small>
            </>
          ) : null}
        </div>
      ) : null}
      {!paramsCollapsed && isRemoteAiNode(type) ? (
        <div className={`nodeTokenStatus ${openRouterConfigured ? "configured" : "missing"}`}>
          <span>OpenRouter: {openRouterConfigured ? "key configured" : "missing"}</span>
          {!openRouterConfigured ? (
            <>
              <strong>Uses OpenRouter by default</strong>
              <button className="nodeSmallButton nodrag nopan" onClick={onConfigureOpenRouter}>Configure OpenRouter</button>
              <small>Direct mode remains available in Advanced for supported legacy providers.</small>
            </>
          ) : null}
        </div>
      ) : null}
      {!paramsCollapsed && isPolzaNode(type) ? (
        <div className={`nodeTokenStatus ${polzaConfigured ? "configured" : "missing"}`}>
          <span>Polza.ai: {polzaConfigured ? `key configured${polzaKeyFingerprint ? ` (${polzaKeyFingerprint})` : ""}` : "missing"}</span>
          {!polzaConfigured ? (
            <>
              <strong>Requires Polza.ai API key</strong>
              <button className="nodeSmallButton nodrag nopan" onClick={onConfigurePolza}>Configure Polza.ai</button>
              <small>Open Settings &gt; AI Providers &gt; Polza.ai</small>
            </>
          ) : null}
        </div>
      ) : null}
      {!paramsCollapsed ? (
        <NodePricingSummary
          costEstimate={costEstimate}
          creditBalance={creditBalance ?? null}
          nodeHasEnoughCredits={nodeHasEnoughCredits}
        />
      ) : null}
      {!paramsCollapsed ? (
        <NodeParamsController
          type={type}
          manifest={manifest}
          params={params}
          connectedInputPorts={connectedInputPorts}
          promptLibrary={promptLibrary ?? { categories: [] }}
          onRefreshPromptLibrary={onRefreshPromptLibrary}
          promptStatusFilter={promptStatusFilter}
          onPromptStatusFilterChange={onPromptStatusFilterChange}
          onPromptContextMenu={onPromptContextMenu}
          stableDiffusionModels={stableDiffusionModels}
          openRouterModels={openRouterModels}
          catalogImageModels={catalogImageModels}
          modelOptionsForNodes={modelOptionsForNodes}
          modelProfiles={modelProfiles}
          polzaTextModels={polzaTextModels}
          polzaImageModels={polzaImageModels}
          polzaVideoModels={polzaVideoModels}
          quotePreview={quotePreview}
          costEstimate={costEstimate}
          resizeInputImage={resizeInputImage}
          chooseCameraInputImage={chooseCameraInputImage}
          onConfigureWorldLabs={onConfigureWorldLabs}
          onPublishNodeOutput={onPublishNodeOutput ? (output) => onPublishNodeOutput(id, output) : undefined}
          onRefreshPricing={onRefreshPricing}
          onRefreshStableDiffusionModels={onRefreshStableDiffusionModels}
          onChange={patchParams}
          onBrowse={(kind) => onBrowseAsset?.(id, kind)}
          canBrowseLocalFiles={supportsLocalFilesystem}
          onOpenImage={onOpenImage}
          renderChooseCameraPointParams={renderChooseCameraPointParams}
        />
      ) : null}
      {!paramsCollapsed && result && shouldShowInlineResult(type) ? renderInlineResult?.({ nodeId: id, type, result, outputPinned, onOpenImage, onDownloadImage, onImageResultContextMenu, onFixNodeOutput, onConfigureMissingSecret: configureMissingSecret }) : null}
      {paramsCollapsed && collapsedImageSrc ? (
        <CollapsedImagePreviewButton
          src={collapsedImageSrc}
          title={collapsedImageTitle}
          filename={collapsedImageFilename}
          onOpenImage={onOpenImage}
        />
      ) : null}
      {ports.outputs.map((port, index) => (
        <React.Fragment key={port.id}>
          <span className="portLabel output" style={{ top: `${portLabelTop(index)}px` }}>
            {port.label ?? port.id}
          </span>
          <Handle
            className={`typedHandle ${port.kind}`}
            id={port.id}
            type="source"
            position={Position.Right}
            style={{ top: `${portHandleTop(index, ports.outputs.length)}px` }}
            title={`${port.id}: ${port.kind}`}
          />
        </React.Fragment>
      ))}
    </div>
  );
}



function DialogueNodeMeta({ routeNode, modelProfiles }: { routeNode: RouteDoc["nodes"][number]; modelProfiles: ModelProfile[] }) {
  const state = normalizeDialogueWorkbenchState(routeNode.params?.state, {
    nodeId: routeNode.id,
    defaultModelProfileId: String(routeNode.params?.defaultModelProfileId ?? "text.default")
  });
  const profile = modelProfiles.find((entry) => entry.id === (state.defaultModelProfileId ?? routeNode.params?.defaultModelProfileId));
  return (
    <>
      <div className="nodeMetaLine withLogo">
        {profile ? <ModelLogoMark logo={modelLogoFor(profile.providerId, profile.modelId, profile.id)} size="tiny" /> : null}
        <span>{profile?.displayName ?? state.defaultModelProfileId ?? "No model profile"} · {state.messages.length} message(s)</span>
      </div>
      <div className="nodeMetaLine">{state.selectedOutputs.length} selected output(s)</div>
    </>
  );
}


function NodePricingSummary({
  costEstimate,
  creditBalance,
  nodeHasEnoughCredits
}: {
  costEstimate?: CostEstimate;
  creditBalance: { balance: number; currency: string } | null;
  nodeHasEnoughCredits: boolean;
}) {
  if (!costEstimate || costEstimate.free || costEstimate.estimatedCredits <= 0) return null;
  const estimatedCredits = Math.max(0, Math.ceil(costEstimate.finalCredits ?? costEstimate.estimatedCredits));
  return (
    <div className={`nodePricingSummary ${nodeHasEnoughCredits ? "" : "insufficient"}`.trim()} title={creditPriceExplanation(costEstimate)}>
      <div>
        <span>Estimated</span>
        <strong>{formatEstimatedCreditsLabel(costEstimate, estimatedCredits)} credits</strong>
      </div>
      <div>
        <span>Balance</span>
        <strong>{creditBalance ? `${formatCredits(creditBalance.balance)} credits` : "unknown"}</strong>
      </div>
      {!nodeHasEnoughCredits ? <p>Not enough credits</p> : null}
    </div>
  );
}


function statusClass(status?: string): string {
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  if (status === "pending") return "pending";
  return "";
}


function pinnedOutputFromParams(params: Record<string, unknown> | undefined): unknown {
  if (!params || !Object.prototype.hasOwnProperty.call(params, "pinnedOutput")) return undefined;
  return params.pinnedOutput;
}


function configureHandlerForError(message: string | undefined, handlers: Record<string, (() => void) | undefined>): (() => void) | undefined {
  if (!message) return undefined;
  const key = Object.keys(handlers).find((candidate) => message.includes(candidate));
  return key ? handlers[key] : undefined;
}


function getNodePorts(type: string, manifest?: NodeManifest, routeNode?: RouteDoc["nodes"][number]): { inputs: PortSpec[]; outputs: PortSpec[] } {
  if (type === "compound.subroute") {
    return {
      inputs: (routeNode?.compound?.inputs ?? []).map((port) => ({ id: port.id, kind: portKindFromManifest(String(port.kind ?? "json")), label: port.label ?? port.id })),
      outputs: (routeNode?.compound?.outputs ?? []).map((port) => ({ id: port.id, kind: portKindFromManifest(String(port.kind ?? "json")), label: port.label ?? port.id }))
    };
  }
  if (manifest && !isKnownBuiltInPortType(type)) {
    return {
      inputs: (manifest.inputs ?? []).map((port) => manifestInputPortSpec(port)),
      outputs: (manifest.outputs ?? []).map((port) => ({ id: port.id, kind: portKindFromManifest(port.type), label: port.label }))
    };
  }
  if (type === "input.text") return { inputs: [], outputs: [{ id: "text", kind: "text" }] };
  if (type === "input.file") return { inputs: [], outputs: [{ id: "file", kind: "file" }] };
  if (type === "input.image") return { inputs: [], outputs: [{ id: "image", kind: "image" }] };
  if (type === "input.video") return { inputs: [], outputs: [{ id: "video", kind: "video" }] };
  if (type === "library.prompt") return { inputs: [], outputs: [{ id: "text", kind: "text" }] };
  if (type === "dialogue.workbench") {
    const selectedOutputs = normalizeDialogueWorkbenchState(routeNode?.params?.state, {
      nodeId: routeNode?.id ?? "dialogue",
      defaultModelProfileId: String(routeNode?.params?.defaultModelProfileId ?? "text.default")
    }).selectedOutputs;
    return {
      inputs: [
        { id: "text", kind: "text", label: "Text", maxConnections: 12 },
        { id: "image", kind: "image", label: "Image", maxConnections: 12 },
        { id: "json", kind: "json", label: "JSON", maxConnections: 12 },
        { id: "context", kind: "conversation_context", label: "Context", maxConnections: 12 }
      ],
      outputs: [
        { id: "conversation_text", kind: "text", label: "conversation_text" },
        { id: "conversation_json", kind: "json", label: "conversation_json" },
        { id: "conversation_capsule", kind: "conversation_context", label: "conversation_capsule" },
        ...selectedOutputs.map((output) => ({ id: output.id, kind: portKindFromDialogueOutput(output.type), label: `${output.name}${output.status === "locked" ? " locked" : ""}` }))
      ]
    };
  }
  if (type === "text.promptCompose") {
    return {
      inputs: [
        { id: "subject", kind: "text", label: "Subject", maxConnections: 24 },
        { id: "style", kind: "text", label: "Style", maxConnections: 24 },
        { id: "scene", kind: "text", label: "Scene", maxConnections: 24 }
      ],
      outputs: [{ id: "text", kind: "text" }]
    };
  }
  if (type === "compound.input") return { inputs: [], outputs: [{ id: "value", kind: portKindFromManifest(String(routeNode?.params?.kind ?? "data")), label: "value" }] };
  if (type === "compound.output") return { inputs: [{ id: "value", kind: portKindFromManifest(String(routeNode?.params?.kind ?? "data")), label: "value" }], outputs: [] };
  if (type === "utility.null") return { inputs: [{ id: "input", kind: "data", label: "Any" }], outputs: [{ id: "output", kind: "data", label: "Output" }] };
  if (type === "replicate.clarity-upscaler") {
    return {
      inputs: [
        { id: "image", kind: "image" },
        { id: "prompt", kind: "text" }
      ],
      outputs: [
        { id: "image", kind: "image" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "gemini.nano-banana-2") {
    return {
      inputs: [
        { id: "images", kind: "image", maxConnections: 14 },
        { id: "prompt", kind: "text" }
      ],
      outputs: [
        { id: "image", kind: "image" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "gemini.llm") {
    return {
      inputs: [
        { id: "systemPrompt", kind: "text", label: "system" },
        { id: "prompt", kind: "text" },
        { id: "images", kind: "image", label: "Images", maxConnections: 14 }
      ],
      outputs: [
        { id: "text", kind: "text" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "local.stableDiffusion.textToImage") {
    return {
      inputs: [
        { id: "prompt", kind: "text" },
        { id: "negativePrompt", kind: "text", label: "negative" }
      ],
      outputs: [
        { id: "image", kind: "image" },
        { id: "metadata", kind: "json" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "ai.image.sd15.qr_monster_hidden_control") {
    return {
      inputs: [
        { id: "controlImage", kind: "image", label: "image" },
        { id: "prompt", kind: "text" },
        { id: "negativePrompt", kind: "text", label: "negative" }
      ],
      outputs: [
        { id: "image", kind: "image" },
        { id: "images", kind: "image", label: "images" },
        { id: "metadata", kind: "json" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "http.request") {
    return {
      inputs: [
        { id: "text", kind: "text" },
        { id: "json", kind: "json", label: "JSON" }
      ],
      outputs: [
        { id: "responseJson", kind: "json", label: "JSON" },
        { id: "responseText", kind: "text", label: "text" },
        { id: "output", kind: "json", label: "output" }
      ]
    };
  }
  if (type === "transform.chooseCameraPoint") {
    return {
      inputs: [{ id: "image", kind: "image", label: "Image" }],
      outputs: [
        { id: "view", kind: "image", label: "View" },
        { id: "panorama", kind: "image", label: "360" }
      ]
    };
  }
  if (type === "preview.image" || type === "preview.panorama360" || type === "transform.panorama360ToFisheye") return { inputs: [{ id: "image", kind: "image", label: "Image" }], outputs: [{ id: "image", kind: "image", label: "Image" }] };
  if (type === "ai.text") {
    return {
      inputs: [
        { id: "systemPrompt", kind: "text", label: "system" },
        { id: "prompt", kind: "text" },
        { id: "images", kind: "image", label: "Images", maxConnections: 14 }
      ],
      outputs: [
        { id: "text", kind: "text" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "ai.image.generate") {
    return {
      inputs: [
        { id: "images", kind: "image", maxConnections: 14 },
        { id: "prompt", kind: "text" }
      ],
      outputs: [
        { id: "image", kind: "image" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "polza.image.generate") {
    return {
      inputs: [
        { id: "images", kind: "image", maxConnections: 14 },
        { id: "prompt", kind: "text" }
      ],
      outputs: [
        { id: "image", kind: "image" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "polza.video.generate") {
    return {
      inputs: [
        { id: "images", kind: "image", label: "Images", maxConnections: polzaVideoImageInputLimit(routeNode) },
        { id: "prompt", kind: "text" }
      ],
      outputs: [
        { id: "video", kind: "video" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "polza.text") {
    return {
      inputs: [
        { id: "systemPrompt", kind: "text", label: "system" },
        { id: "prompt", kind: "text" },
        { id: "images", kind: "image", label: "Images", maxConnections: 14 }
      ],
      outputs: [
        { id: "text", kind: "text" },
        { id: "output", kind: "json", label: "JSON" }
      ]
    };
  }
  if (type === "replicate.model") return { inputs: [{ id: "input", kind: "json", label: "JSON" }], outputs: [{ id: "output", kind: "json", label: "JSON" }] };
  if (type === "output.text") return { inputs: [{ id: "from", kind: "text" }], outputs: [{ id: "text", kind: "text" }] };
  if (type === "output.file") return { inputs: [{ id: "from", kind: "text" }], outputs: [] };
  if (type === "transform.template") return { inputs: [{ id: "template", kind: "text" }], outputs: [{ id: "text", kind: "text" }] };
  if (type === "debug.log") return { inputs: [{ id: "value", kind: "json", label: "JSON" }], outputs: [{ id: "value", kind: "json", label: "JSON" }] };
  return { inputs: [{ id: "input", kind: "json", label: "JSON" }], outputs: [{ id: "output", kind: "json", label: "JSON" }] };
}

function portLabel(port: PortSpec, connectedCount: number): string {
  const base = port.label ?? port.id;
  return typeof port.maxConnections === "number" ? `${base} ${connectedCount}/${port.maxConnections}` : base;
}


function polzaVideoImageInputLimit(routeNode?: RouteDoc["nodes"][number]): number {
  return polzaVideoImageInputLimitForModel({ id: String(routeNode?.params?.model ?? "") });
}


function polzaVideoImageInputLimitForModel(modelInfo: Pick<PolzaModel, "id" | "maxImageInputs">): number {
  const explicit = Number(modelInfo.maxImageInputs);
  if (Number.isFinite(explicit) && explicit > 0 && !isPolzaVideoUpscaleModelId(modelInfo.id)) return Math.max(1, Math.floor(explicit));
  const model = String(modelInfo.id ?? "").toLowerCase();
  if (!model) return 14;
  if (isPolzaVideoUpscaleModelId(model)) return 1;
  if (/veo[-_]?3/.test(model)) return 2;
  if (/seedance/.test(model)) return 9;
  if (/wan/.test(model)) return 2;
  return 14;
}


function isPolzaVideoUpscaleModelId(modelId: string | undefined): boolean {
  return /(^|\/)(video-)?upscale|upscaler|topaz/i.test(String(modelId ?? ""));
}


function manifestInputPortSpec(port: NodeManifest["inputs"][number]): PortSpec {
  const kind = portKindFromManifest(port.type);
  return {
    id: port.id,
    kind,
    label: port.label,
    maxConnections: port.id === "images" && kind === "image" ? 14 : undefined
  };
}


function isKnownBuiltInPortType(type: string): boolean {
  return type === "compound.subroute" || isPolzaNode(type) || library.some((item) => item.type === type);
}


const library = [
  { type: "input.text" },
  { type: "library.prompt" },
  { type: "dialogue.workbench" },
  { type: "text.promptCompose" },
  { type: "input.image" },
  { type: "input.video" },
  { type: "input.file" },
  { type: "compound.input" },
  { type: "compound.output" },
  { type: "transform.template" },
  { type: "utility.null" },
  { type: "gemini.llm" },
  { type: "gemini.nano-banana-2" },
  { type: "ai.text" },
  { type: "ai.image.generate" },
  { type: "local.stableDiffusion.textToImage" },
  { type: "replicate.model" },
  { type: "replicate.clarity-upscaler" },
  { type: "http.request" },
  { type: "transform.chooseCameraPoint" },
  { type: "preview.image" },
  { type: "preview.panorama360" },
  { type: "debug.log" },
  { type: "output.text" },
  { type: "output.file" },
  { type: "transform.imageResize" },
  { type: "transform.panorama360ToFisheye" },
  { type: "ai.image.sd15.qr_monster_hidden_control" },
  { type: "compound.subroute" }
];

function portKindFromManifest(value: string): PortKind {
  if (value === "text" || value === "image" || value === "video" || value === "file" || value === "json" || value === "data" || value === "conversation_context") return value;
  if (value === "number" || value === "boolean") return "data";
  return "json";
}


function portKindFromDialogueOutput(type: DialogueOutputType): PortKind {
  if (type === "text" || type === "image" || type === "file" || type === "json") return type;
  return "json";
}


function requiresEnv(manifest: NodeManifest | undefined, key: string): boolean {
  return Boolean(manifest?.permissions.env?.includes(key));
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}


function isReplicateNode(type: string): boolean {
  return type === "replicate.model" || type === "replicate.clarity-upscaler";
}


function isGeminiNode(type: string): boolean {
  return type === "gemini.nano-banana-2" || type === "gemini.llm";
}


function isRemoteAiNode(type: string): boolean {
  return type === "ai.text" || type === "ai.image.generate";
}


function isPolzaNode(type: string): boolean {
  return type === "polza.text" || type === "polza.image.generate" || type === "polza.video.generate";
}


function executorKind(type: string, manifest?: NodeManifest): string {
  if (manifest?.origin && manifest.origin !== "bundled") return "custom";
  if (manifest?.executor.type === "plugin") return "custom";
  if (type === "ai.image.sd15.qr_monster_hidden_control") return "local";
  if (type.startsWith("local.")) return "local";
  if (type.startsWith("ai.")) return "openrouter";
  if (type.startsWith("polza.")) return "polza";
  if (type.startsWith("gemini.")) return "gemini";
  if (type.startsWith("replicate.")) return "replicate";
  if (type.startsWith("http.")) return "http";
  if (type.startsWith("input.") || type.startsWith("output.") || type.startsWith("preview.") || type.startsWith("debug.") || type.startsWith("transform.") || type.startsWith("library.") || type.startsWith("compound.")) return "local";
  return "custom";
}


function executorLabel(type: string, manifest?: NodeManifest): string {
  if (manifest?.executor.type === "plugin") return `${manifest.executor.runtime ?? "plugin"} plugin`;
  if (manifest?.executor.type === "declarative") return "declarative";
  const kind = executorKind(type, manifest);
  if (kind === "gemini") return "Gemini";
  if (kind === "polza") return "Polza.ai";
  if (kind === "openrouter") return "OpenRouter";
  if (kind === "replicate") return "Replicate";
  if (kind === "http") return "HTTP";
  if (kind === "local") return "local";
  return "unknown/custom";
}


function shouldShowInlineResult(type: string): boolean {
  if (type === "transform.chooseCameraPoint") return false;
  return !type.startsWith("input.") && type !== "library.prompt";
}


function shouldShowNodeRunButton(type: string): boolean {
  return !type.startsWith("input.");
}


function nodeIcon(type: string) {
  if (type === "input.text") return <Type size={15} />;
  if (type === "input.image") return <ImageIcon size={15} />;
  if (type === "input.video") return <Video size={15} />;
  if (type === "library.prompt") return <BookOpen size={15} />;
  if (type === "dialogue.workbench") return <MessageSquareText size={15} />;
  if (type === "text.promptCompose") return <Braces size={15} />;
  if (type === "compound.input") return <ChevronRight size={15} />;
  if (type === "compound.output") return <ChevronRight size={15} />;
  if (type === "transform.template") return <Braces size={15} />;
  if (type === "transform.chooseCameraPoint") return <Globe size={15} />;
  if (type === "transform.panorama360ToFisheye") return <Aperture size={15} />;
  if (type === "replicate.clarity-upscaler") return <Wand2 size={15} />;
  if (type === "replicate.model") return <span className="providerGlyph">R</span>;
  if (type === "gemini.llm") return <Type size={15} />;
  if (type === "polza.text") return <span className="providerGlyph">P</span>;
  if (type === "polza.image.generate") return <ImageIcon size={15} />;
  if (type === "polza.video.generate") return <Film size={15} />;
  if (type === "ai.text") return <Type size={15} />;
  if (type === "ai.image.generate") return <ImageIcon size={15} />;
  if (type.includes("seedance")) return <Film size={15} />;
  if (type === "gemini.nano-banana-2") return <Sparkles size={15} />;
  if (type === "local.stableDiffusion.textToImage") return <Cpu size={15} />;
  if (type === "ai.image.sd15.qr_monster_hidden_control") return <Sparkles size={15} />;
  if (type === "http.request") return <Globe size={15} />;
  if (type === "preview.image" || type === "preview.panorama360") return <Eye size={15} />;
  if (type === "debug.log") return <Bug size={15} />;
  if (type === "utility.null") return <Eraser size={15} />;
  if (type === "compound.subroute") return <FolderOpen size={15} />;
  if (type === "output.text") return <FileText size={15} />;
  if (type === "output.file") return <Save size={15} />;
  return <FileJson size={15} />;
}


function compactNodeClass(type: string): string {
  return type === "transform.panorama360ToFisheye" || type === "transform.chooseCameraPoint" ? "compactRouteNode" : "";
}


function nodeIconClass(type: string): string {
  if (type.includes("seedance")) return "seedance";
  if (type.startsWith("input.")) return "input";
  if (type.startsWith("ai.")) return "gemini";
  if (type.startsWith("polza.")) return "polza";
  if (type === "compound.input") return "input";
  if (type.startsWith("library.")) return "transform";
  if (type.startsWith("dialogue.")) return "dialogue";
  if (type.startsWith("text.")) return "transform";
  if (type.startsWith("output.")) return "output";
  if (type === "compound.output") return "output";
  if (type.startsWith("replicate.")) return "replicate";
  if (type.startsWith("gemini.")) return "gemini";
  if (type.startsWith("local.")) return "local";
  if (type.startsWith("http.")) return "http";
  if (type.startsWith("preview.")) return "preview";
  if (type.startsWith("debug.")) return "debug";
  if (type.startsWith("utility.")) return "debug";
  if (type.startsWith("transform.")) return "transform";
  if (type === "compound.subroute") return "transform";
  return "generic";
}


function downloadFilename(value: unknown, fallback = "snarkroute-image.png"): string {
  const label = imageLabel(value).split(/[\\/]/).pop() ?? fallback;
  return label || fallback;
}

