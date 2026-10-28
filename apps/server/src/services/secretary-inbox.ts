import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * The owner's inbox in the existing «Решения» sheet. Reads use a read-only token;
 * only explicit answers request write access, and only column F is updated.
 * The registry's service-account key stays on the server and is never returned.
 */
export const SECRETARY_SHEET_ID = process.env.SECRETARY_SHEET_ID ?? "1Ti-zii3XyT8jP3PtV6-miY8HTCaEu_IcpTTbg62jas8";
export const SECRETARY_KEY_PATH = process.env.SECRETARY_SA_KEY ?? "Y:/Приложения/Tove/data/secrets/google_service_account.json";
const RANGE = "Решения!A2:G1000";
/** Column G marks rows the agents closed themselves («снято…», «исполнено…»); the Секретарь page hides them too. */
const CLOSED_RE = /^(снято|исполнено|выполнено|закрыто)/i;
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const CACHE_MS = 60_000;

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };
export type SecretaryInbox = { pending: number | null; checkedAt: string; error?: string };
export type SecretaryQuestion = { id: string; date: string; agent: string; question: string; suggestions: string; answer: string; note: string; closed: boolean };
export type SecretaryQuestions = { questions: SecretaryQuestion[]; pending: number; checkedAt: string };
type Options = { fetchImpl?: typeof fetch; keyPath?: string; now?: () => number };

export class SecretaryInboxError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}

/** Rows with a number in A and a question in D; open while F (the answer) is empty and G is not a closing mark. */
export function countPending(values: unknown[][] | undefined): number {
  return (values ?? []).filter(row => /^\d+$/.test(String(row[0] ?? "").trim())
    && String(row[3] ?? "").trim() !== "" && String(row[5] ?? "").trim() === ""
    && !CLOSED_RE.test(String(row[6] ?? "").trim())).length;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function signedAssertion(account: ServiceAccount, nowSeconds: number, scope = SCOPE): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: account.client_email, scope, aud: account.token_uri ?? "https://oauth2.googleapis.com/token",
    iat: nowSeconds, exp: nowSeconds + 3600
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${base64url(signer.sign(account.private_key))}`;
}

export function createSecretaryInboxService(options: Options = {}) {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const tokens = new Map<string, { value: string; expiresAt: number }>();
  type Loaded = { rows: Array<SecretaryQuestion & { row: number }>; snapshot: SecretaryQuestions };
  let cached: Loaded | undefined;
  let cacheUntil = 0;
  let lastError: SecretaryInboxError | undefined;
  let inflight: Promise<Loaded> | undefined;
  let writeQueue: Promise<unknown> = Promise.resolve();

  async function tokenFor(scope: string) {
    const token = tokens.get(scope);
    if (token && token.expiresAt - 60_000 > now()) return token.value;
    let account: ServiceAccount;
    try {
      account = JSON.parse(await readFile(options.keyPath ?? SECRETARY_KEY_PATH, "utf8")) as ServiceAccount;
    } catch { throw new SecretaryInboxError(503, "Не удалось прочитать подключение к реестру Секретаря."); }
    const response = await fetchImpl(account.token_uri ?? "https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedAssertion(account, Math.floor(now() / 1000), scope) }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new SecretaryInboxError(503, `Не удалось подключиться к реестру: Google auth HTTP ${response.status}.`);
    const body = await response.json() as { access_token: string; expires_in?: number };
    if (!body.access_token) throw new SecretaryInboxError(503, "Google не подтвердил доступ к реестру.");
    tokens.set(scope, { value: body.access_token, expiresAt: now() + (body.expires_in ?? 3600) * 1000 });
    return body.access_token;
  }

  function snapshot(rows: Loaded["rows"]): Loaded {
    return { rows, snapshot: {
      questions: rows.map(({ row: _row, ...question }) => question),
      pending: rows.filter(question => !question.answer && !question.closed).length,
      checkedAt: new Date(now()).toISOString()
    } };
  }

  async function fetchQuestions(): Promise<Loaded> {
    try {
      const token = await tokenFor(SCOPE);
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${SECRETARY_SHEET_ID}/values/${encodeURIComponent(RANGE)}`;
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new SecretaryInboxError(503, `Не удалось прочитать реестр: Google Sheets HTTP ${response.status}.`);
      const body = await response.json() as { values?: unknown[][] };
      const rows = (body.values ?? []).flatMap((cells, index) => {
        const [id, date, agent, question, suggestions, answer, note] = Array.from({ length: 7 }, (_, i) => String(cells[i] ?? "").trim());
        if (!/^\d+$/.test(id) || !question) return [];
        return [{ row: index + 2, id, date, agent, question, suggestions, answer, note, closed: CLOSED_RE.test(note) }];
      });
      cached = snapshot(rows);
      lastError = undefined;
      return cached;
    } catch (error) {
      lastError = error instanceof SecretaryInboxError ? error : new SecretaryInboxError(503, "Реестр Секретаря недоступен. Попробуй обновить позже.");
      throw lastError;
    } finally { cacheUntil = now() + CACHE_MS; }
  }

  async function load(fresh = false): Promise<Loaded> {
    while (inflight) { await inflight; if (!fresh && cached) return cached; }
    if (!fresh && now() < cacheUntil) {
      if (lastError) throw lastError;
      if (cached) return cached;
    }
    inflight = fetchQuestions();
    try { return await inflight; } finally { inflight = undefined; }
  }

  async function summary(): Promise<SecretaryInbox> {
    try { await writeQueue; const { pending, checkedAt } = (await load()).snapshot; return { pending, checkedAt }; }
    catch (error) { return { pending: cached?.snapshot.pending ?? null, checkedAt: new Date(now()).toISOString(), error: (error as Error).message }; }
  }

  function answer(id: string, text: string, expectedQuestion: string): Promise<SecretaryQuestions> {
    const value = text.trim();
    if (!/^\d{1,20}$/.test(id) || !value || value.length > 10_000 || !expectedQuestion.trim() || expectedQuestion.length > 20_000) {
      return Promise.reject(new SecretaryInboxError(400, "Укажи вопрос и непустой ответ длиной до 10 000 символов."));
    }
    // Sheets values have no compare-and-swap: serialize local answers and re-read the current rows.
    const operation = writeQueue.then(async () => {
      let token: string;
      try { token = await tokenFor(WRITE_SCOPE); }
      catch (error) { throw error instanceof SecretaryInboxError ? error : new SecretaryInboxError(503, "Не удалось получить доступ для сохранения ответа."); }
      const current = await load(true);
      const matches = current.rows.filter(question => question.id === id);
      if (!matches.length) throw new SecretaryInboxError(404, "Вопрос больше не найден в реестре.");
      if (matches.length !== 1) throw new SecretaryInboxError(409, "В реестре несколько вопросов с этим номером. Ответ не сохранён.");
      const question = matches[0];
      if (question.question !== expectedQuestion || question.closed) throw new SecretaryInboxError(409, "Вопрос изменился или снят. Обнови список перед ответом.");
      if (question.answer) {
        if (question.answer === value) return current.snapshot;
        throw new SecretaryInboxError(409, "На вопрос уже ответили. Обнови список.");
      }
      const range = `Решения!F${question.row}`;
      try {
        const response = await fetchImpl(`https://sheets.googleapis.com/v4/spreadsheets/${SECRETARY_SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
          method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ values: [[value]] }), signal: AbortSignal.timeout(10_000)
        });
        if (!response.ok) throw new SecretaryInboxError(503, `Ответ не подтверждён: Google Sheets HTTP ${response.status}. Обнови список перед повтором.`);
        const result = await response.json() as { updatedCells?: number };
        if (result.updatedCells !== 1) throw new SecretaryInboxError(503, "Реестр не подтвердил сохранение ответа. Обнови список.");
        cached = snapshot(current.rows.map(row => row === question ? { ...row, answer: value } : row));
        lastError = undefined; cacheUntil = now() + CACHE_MS;
        return cached.snapshot;
      } catch (error) {
        cacheUntil = 0;
        throw error instanceof SecretaryInboxError ? error : new SecretaryInboxError(503, "Не удалось подтвердить сохранение. Обнови список перед повтором.");
      }
    });
    writeQueue = operation.catch(() => undefined);
    return operation;
  }

  return { summary, questions: async (fresh = false) => { await writeQueue; return (await load(fresh)).snapshot; }, answer };
}

export const secretaryInbox = createSecretaryInboxService();
export function readSecretaryInbox(options?: Options): Promise<SecretaryInbox> {
  return (options ? createSecretaryInboxService(options) : secretaryInbox).summary();
}
