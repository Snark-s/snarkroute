from pathlib import Path
p=Path(r"Y:\Процесс\SnarkRoute\apps\server\src\model-gateway-jobs\service.ts")
s=p.read_text(encoding="utf-8")
s=s.replace('export type GenerationMediaKind = "image" | "video" | "audio";','export type GenerationMediaKind = "image" | "video" | "audio" | "model";')
s=s.replace('''  capability: "image.generate" | "image.edit" | "image.reference" | "image.upscale" | "video.generate" | "video.upscale";''','''  capability: "image.generate" | "image.edit" | "image.reference" | "image.upscale" | "video.generate" | "video.upscale" | "model.generate";''')
old='''    "ai.image.generate": { media: "image", capabilities: ["image.generate", "image.edit", "image.reference"] },
    "replicate.clarity-upscaler": { media: "image", capabilities: ["image.upscale"] },
'''
new='''    "ai.image.generate": { media: "image", capabilities: ["image.generate", "image.edit", "image.reference"] },
    "ai.3d.generate": { media: "model", capabilities: ["model.generate"] },
    "replicate.clarity-upscaler": { media: "image", capabilities: ["image.upscale"] },
'''
if old not in s: raise SystemExit("supported runners marker missing")
s=s.replace(old,new)
old='''function defaultMimeType(kind: GenerationMediaKind): string { return kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "audio/mpeg"; }
function requestMediaKind(request: GenerationJobRequest): GenerationMediaKind { return request.outputMediaType ?? (request.capability.startsWith("image.") ? "image" : request.capability.startsWith("audio.") ? "audio" : "video"); }
'''
new='''function defaultMimeType(kind: GenerationMediaKind): string {
  return kind === "image" ? "image/png"
    : kind === "video" ? "video/mp4"
    : kind === "model" ? "model/gltf-binary"
    : "audio/mpeg";
}
function requestMediaKind(request: GenerationJobRequest): GenerationMediaKind {
  return request.outputMediaType
    ?? (request.capability.startsWith("image.") ? "image"
      : request.capability.startsWith("audio.") ? "audio"
      : request.capability.startsWith("model.") ? "model"
      : "video");
}
'''
if old not in s: raise SystemExit("mime/request kind block missing")
s=s.replace(old,new)
p.write_text(s,encoding="utf-8")
print("patched model-gateway model media")
