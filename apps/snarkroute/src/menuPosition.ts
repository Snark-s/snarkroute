import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

export type MenuPoint = { x: number; y: number };
export type MenuSize = { width: number; height: number };
export type MenuViewport = MenuSize;

export function clampMenuPosition(point: MenuPoint, menu: MenuSize, viewport: MenuViewport, margin = 8): MenuPoint {
  let x = point.x + menu.width > viewport.width - margin ? point.x - menu.width : point.x;
  let y = point.y + menu.height > viewport.height - margin ? point.y - menu.height : point.y;
  x = Math.min(Math.max(margin, x), Math.max(margin, viewport.width - menu.width - margin));
  y = Math.min(Math.max(margin, y), Math.max(margin, viewport.height - menu.height - margin));
  return { x, y };
}

export function useClampedMenuPosition(point: MenuPoint | null) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [menuSize, setMenuSize] = useState<MenuSize | null>(null);
  const [viewport, setViewport] = useState<MenuViewport>(() => ({ width: window.innerWidth, height: window.innerHeight }));

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !point) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setMenuSize({ width: rect.width, height: rect.height });
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [point?.x, point?.y]);

  const position = useMemo(
    () => point && menuSize ? clampMenuPosition(point, menuSize, viewport) : point ?? { x: 0, y: 0 },
    [menuSize, point, viewport]
  );
  const style: CSSProperties = { left: position.x, top: position.y, visibility: menuSize ? "visible" : "hidden" };
  return { ref, style, flippedX: Boolean(point && menuSize && position.x < point.x) };
}
