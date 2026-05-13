import { buildServer } from "./app";
export const port = Number(process.env.API_PORT ?? 4317);
export const host = process.env.HOST ?? "127.0.0.1";
export function startServer() {
  const app = buildServer();
  app.listen({ port, host }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
  return app;
}