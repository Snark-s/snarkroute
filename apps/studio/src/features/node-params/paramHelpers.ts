import type { ChangeEvent, MutableRefObject } from "react";
import type { PendingTextSelection } from "../../studioTypes";

export function numericParam(value: string): unknown {
  if (!value.trim()) return "";
  const number = Number(value.replace(",", "."));
  return Number.isFinite(number) ? number : value;
}

export function updateTextFieldPreservingCaret(
  event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  pendingSelectionRef: MutableRefObject<PendingTextSelection | null>,
  commit: (value: string) => void
) {
  const target = event.currentTarget;
  pendingSelectionRef.current = {
    target,
    selectionStart: target.selectionStart,
    selectionEnd: target.selectionEnd,
    selectionDirection: target.selectionDirection
  };
  commit(target.value);
}

export function restorePendingTextSelection(pendingSelectionRef: MutableRefObject<PendingTextSelection | null>) {
  const pendingSelection = pendingSelectionRef.current;
  pendingSelectionRef.current = null;
  if (!pendingSelection) return;
  const { target, selectionStart, selectionEnd, selectionDirection } = pendingSelection;
  if (!target.isConnected || selectionStart === null || selectionEnd === null) return;
  if (document.activeElement !== target) {
    target.focus({ preventScroll: true });
  }
  const valueLength = target.value.length;
  target.setSelectionRange(Math.min(selectionStart, valueLength), Math.min(selectionEnd, valueLength), selectionDirection ?? "none");
}
