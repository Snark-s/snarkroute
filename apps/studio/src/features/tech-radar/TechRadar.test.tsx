import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TechRadar } from "./TechRadar";

describe("Tech Radar initial screen", () => {
  it("renders a Russian intake and catalog while no project or detail is selected", () => {
    const markup = renderToStaticMarkup(createElement(TechRadar, { apiBase: "http://127.0.0.1:4317" }));
    expect(markup).toContain("Технорадар"); expect(markup).toContain("Исследовать"); expect(markup).toContain("Карта возможностей"); expect(markup).toContain("Очередь исследований"); expect(markup).toContain("Каталог проектов");
  });
});
