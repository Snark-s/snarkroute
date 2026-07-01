export function canvasActionNeedsDialog(action: { dialog?: { enabled: boolean; params: string[] } } | undefined): boolean {
  return action?.dialog?.enabled === true && action.dialog.params.length > 0;
}
