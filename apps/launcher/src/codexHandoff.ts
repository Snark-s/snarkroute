export type CodexHandoffSuccess = {
  ok: true;
  confirmed: true;
  threadId: string;
  turnId?: string;
  handoffPath: string;
};

export type CodexHandoffErrorDetails = {
  error?: string;
  stage?: string;
  contextPreserved?: boolean;
  handoffPath?: string;
  threadId?: string;
  taskCreated?: boolean;
  retryable?: boolean;
};

export type CodexHandoffRetry = {
  taskId: string;
  workspace: string;
  handoffPath: string;
  existingThreadId?: string;
};

export class ApiRequestError extends Error {
  constructor(readonly status: number, readonly details: CodexHandoffErrorDetails) {
    super(details.error ?? `HTTP ${status}`);
    this.name = "ApiRequestError";
  }
}

export function confirmedCodexNotice(result: CodexHandoffSuccess): string {
  if (result.confirmed !== true || !result.threadId) throw new Error("Codex did not confirm task creation.");
  return `Задача передана и подтверждена в Codex Desktop (${result.threadId}).`;
}

export function codexRetryFromError(
  error: unknown,
  taskId: string,
  workspace: string
): CodexHandoffRetry | undefined {
  if (!(error instanceof ApiRequestError)) return undefined;
  const details = error.details;
  if (!details.retryable || !details.contextPreserved || !details.handoffPath) return undefined;
  return {
    taskId,
    workspace,
    handoffPath: details.handoffPath,
    existingThreadId: details.taskCreated ? details.threadId : undefined
  };
}
