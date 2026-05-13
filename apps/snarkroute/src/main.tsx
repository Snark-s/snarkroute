import "./styles.css";
import type { LivingNode, ToolAction } from "@snarkroute/core";
import { Layers3, MousePointer2, PanelRight, Sparkles } from "lucide-react";
import React from "react";
import { createRoot } from "react-dom/client";

const now = new Date().toISOString();

const placeholderNode: LivingNode = {
  id: "idea-001",
  type: "idea",
  title: "First idea node",
  description: "A reserved place for future Living Canvas node, card stack, and inherited context behavior.",
  inputs: [],
  candidates: [
    {
      id: "card-001",
      parentNodeId: "idea-001",
      mediaType: "text",
      status: "draft",
      createdAt: now,
      updatedAt: now
    }
  ],
  activeCandidateId: "card-001",
  context: {
    style: "Inherited until changed",
    atmosphere: "Unset",
    world: "Project local",
    format: "Open"
  },
  createdAt: now,
  updatedAt: now
};

const placeholderTools: ToolAction[] = [
  {
    id: "boojumroute.tool.placeholder",
    title: "BoojumRoute tool action",
    mode: "addCandidate",
    inputTypes: ["living-node"],
    outputTypes: ["candidate-card"],
    executorRef: "boojumroute://tool-route/placeholder"
  }
];

function App() {
  const activeCard = placeholderNode.candidates.find((candidate) => candidate.id === placeholderNode.activeCandidateId);

  return (
    <main className="livingCanvasShell">
      <header className="topbar">
        <div className="brand">
          <img src="/snarkroute-icon.png" alt="" />
          <div>
            <h1>SnarkRoute</h1>
            <span>Living Canvas</span>
          </div>
        </div>
        <div className="statusPill">Empty shell</div>
      </header>

      <section className="canvas">
        <div className="canvasGrid" />
        <article className="livingNode">
          <div className="nodeHeader">
            <MousePointer2 size={18} />
            <div>
              <strong>{placeholderNode.title}</strong>
              <span>Node = idea / entity / concept</span>
            </div>
          </div>
          <p>{placeholderNode.description}</p>
          <div className="stack">
            <div className="stackHeader">
              <Layers3 size={16} />
              <span>Card stack</span>
            </div>
            <div className="candidateCard">
              <strong>Active card</strong>
              <span>{activeCard?.mediaType ?? "none"} · {activeCard?.status ?? "missing"}</span>
            </div>
          </div>
        </article>
      </section>

      <aside className="inspector">
        <div className="panelTitle">
          <PanelRight size={17} />
          <h2>Context</h2>
        </div>
        <dl>
          <div><dt>Style</dt><dd>{placeholderNode.context?.style}</dd></div>
          <div><dt>Inputs</dt><dd>{placeholderNode.inputs.length || "none yet"}</dd></div>
          <div><dt>Tools</dt><dd>{placeholderTools.length} reserved action</dd></div>
        </dl>
        <div className="toolStub">
          <Sparkles size={16} />
          <span>{placeholderTools[0].title}</span>
        </div>
      </aside>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
