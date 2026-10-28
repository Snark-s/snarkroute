import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerSecretaryRoutes } from "./secretary";
import { SecretaryInboxError } from "../services/secretary-inbox";

function fixture(allowed = true) {
  const app = Fastify();
  const snapshot = { questions: [], pending: 0, checkedAt: "2026-10-26T12:00:00Z" };
  const service = { questions: vi.fn(async () => snapshot), answer: vi.fn(async () => snapshot) };
  registerSecretaryRoutes(app, () => allowed, service);
  return { app, service };
}

describe("secretary routes", () => {
  it("lists questions and forwards an answer with the expected question", async () => {
    const { app, service } = fixture();
    try {
      expect((await app.inject({ method: "GET", url: "/api/system/secretary/questions" })).json()).toMatchObject({ ok: true, pending: 0, questions: [] });
      const result = await app.inject({ method: "POST", url: "/api/system/secretary/questions/17/answer", payload: { answer: " да ", expectedQuestion: "Продолжать?" } });
      expect(result.statusCode).toBe(200);
      expect(service.answer).toHaveBeenCalledWith("17", "да", "Продолжать?");
    } finally { await app.close(); }
  });

  it("denies both reading and answering outside the existing local-client boundary", async () => {
    const { app, service } = fixture(false);
    try {
      for (const method of ["GET", "POST"] as const) {
        expect((await app.inject({ method, url: `/api/system/secretary/questions${method === "POST" ? "/17/answer" : ""}`, ...(method === "POST" ? { payload: { answer: "да", expectedQuestion: "Вопрос" } } : {}) })).statusCode).toBe(403);
      }
      expect(service.questions).not.toHaveBeenCalled();
      expect(service.answer).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("validates the answer, question and id and reports write conflicts", async () => {
    const { app, service } = fixture();
    try {
      for (const payload of [{ answer: " " }, { answer: "да" }, { answer: "да", expectedQuestion: "Вопрос", extra: true }, { answer: "а".repeat(10001), expectedQuestion: "Вопрос" }]) {
        expect((await app.inject({ method: "POST", url: "/api/system/secretary/questions/17/answer", payload })).statusCode).toBe(400);
      }
      expect((await app.inject({ method: "POST", url: "/api/system/secretary/questions/nope/answer", payload: { answer: "да", expectedQuestion: "Вопрос" } })).statusCode).toBe(400);
      expect(service.answer).not.toHaveBeenCalled();
      service.answer.mockRejectedValueOnce(new SecretaryInboxError(409, "На вопрос уже ответили."));
      expect((await app.inject({ method: "POST", url: "/api/system/secretary/questions/17/answer", payload: { answer: "да", expectedQuestion: "Вопрос" } })).statusCode).toBe(409);
      service.questions.mockRejectedValueOnce(new Error("private upstream detail"));
      const error = await app.inject({ method: "GET", url: "/api/system/secretary/questions" });
      expect(error.statusCode).toBe(503);
      expect(error.body).not.toContain("private upstream detail");
    } finally { await app.close(); }
  });
});
