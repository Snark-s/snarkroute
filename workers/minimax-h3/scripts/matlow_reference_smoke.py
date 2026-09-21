"""Submit/inspect one authenticated local visual Ref2VA GPU smoke test."""
import argparse
import json
from pathlib import Path
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", type=Path)
    parser.add_argument("--video", type=Path)
    parser.add_argument("--status")
    args = parser.parse_args()
    token = (Path.home() / "h3/runtime/worker-token").read_text().strip()

    def call(path, data=None, mime="application/json"):
        request = Request("http://127.0.0.1:18080" + path, data=data,
                          headers={"Authorization": "Bearer " + token, "Content-Type": mime})
        with urlopen(request, timeout=30) as response:
            return json.load(response)

    if args.status:
        print(json.dumps(call("/v1/jobs/" + args.status)))
        return
    conditions = []
    for path, kind, mime in [(args.image, "image", "image/png"), (args.video, "video", "video/mp4")]:
        if path:
            asset = call("/v1/assets", path.read_bytes(), mime)
            conditions.append({"type": kind, "role": "reference", "uri": asset["uri"]})
    if not conditions:
        parser.error("provide --image and/or --video")
    prompt = "A cinematic scene."
    if args.image:
        prompt += " Keep the character and visual style from <Picture 1>."
    if args.video:
        prompt += " Follow the character motion and camera movement from <Video 1>."
    job = call("/v1/jobs", json.dumps({
        "task": "ref2va", "prompt": prompt, "conditions": conditions,
        "target": {"duration_seconds": 5, "aspect_ratio": "16:9"},
        "quality_mode": "preview", "num_inference_steps": 4, "seed": 134897941,
    }).encode())
    print(json.dumps(job))


if __name__ == "__main__":
    main()
