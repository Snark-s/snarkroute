/** Live probe: which process does SnarkRoute's attribution see for a request made by this process? */
import { createServer } from "node:http";
import { CallerAttribution } from "../src/agent-ops/caller-process";

const callers = new CallerAttribution({ agentRoots: () => new Map() });
const server = createServer(async (req, res) => {
  const started = Date.now();
  const result = await callers.attribute(req.socket.remotePort!, req.socket.localPort!);
  res.end(JSON.stringify({ result, ms: Date.now() - started }));
});
server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as { port: number }).port;
  console.log(await (await fetch(`http://127.0.0.1:${port}/`)).text());
  server.close();
});
