const PREFIX = "snarkroute.text-dialogue-draft.";

export function readTextDialogueDraft(storage: Storage, nodeId: string): string {
  try { return storage.getItem(`${PREFIX}${nodeId}`) ?? ""; } catch { return ""; }
}

export function writeTextDialogueDraft(storage: Storage, nodeId: string, text: string): void {
  try {
    const key = `${PREFIX}${nodeId}`;
    if (text) storage.setItem(key, text);
    else storage.removeItem(key);
  } catch {
    // Draft persistence is best-effort.
  }
}
