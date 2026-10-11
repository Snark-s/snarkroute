import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
 serviceEndpointRegistry, localServicePort, localServiceUrl,
 assertLocalInferenceEndpoint
} from "../apps/server/src/services/local-service-endpoints";

const registry=serviceEndpointRegistry();
assert.equal(registry.modelPolicy.routeVia, "snarkroute");
assert.equal(registry.modelPolicy.directMixarInference, false);
const ports=Object.values(registry.services).map(x=>x.port);
assert.equal(ports.length,new Set(ports).size);
assert.equal(localServicePort("snarkroute"),4317);
assert.equal(localServicePort("snarkbridge_tunnel"),8080);
assert.equal(localServiceUrl("ollama_inference","/v1"),"http://127.0.0.1:11434/v1");
assertLocalInferenceEndpoint("http://127.0.0.1:8081/v1");
assertLocalInferenceEndpoint("http://127.0.0.1:11434/v1");
assert.throws(() => assertLocalInferenceEndpoint("http://127.0.0.1:8080/v1"), /Unregistered/);
const path=join(tmpdir(),`snarkroute-port-validation-${process.pid}.json`);
try {
 const clone=JSON.parse(JSON.stringify(registry));
 clone.services.bonsai_inference.port=8080;
 writeFileSync(path,JSON.stringify(clone));
 assert.throws(() => serviceEndpointRegistry(path),/duplicated port/i);
} finally {try{unlinkSync(path);}catch{}}
console.log("SNARKROUTE_TS_PORT_AUTHORITY_PASS",ports.join(","));
