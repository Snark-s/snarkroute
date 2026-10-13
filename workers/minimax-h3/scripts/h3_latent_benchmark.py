#!/usr/bin/env python3
"""Explicit local bake-off: pixel Extend, AV latent Extend, and tone correction.

Run as a module or with PYTHONPATH set to the worker. No service or UI required.
Progress/results are written after every stage; failures are never marked passed.
"""
from __future__ import annotations

import argparse
import json
import os
import traceback
from pathlib import Path

from app.backends.h3_latent_archive import read_h3_latent, save_h3_latent
from app.backends.h3_latent_decode import decode_h3_archive, save_h3_video
from app.backends.h3_latent_extend import stitch_h3_latents
from app.backends.h3_latent_metrics import measure_video
from app.backends.matlow_runtime import MatlowRuntime, _validate_experiment_geometry
from app.config import Settings
from app.models import GenerateRequest

DEFAULT_PROMPT = (
    "One continuous fixed camera shot of a red ceramic teapot on a pale wooden table in a sunlit kitchen. "
    "A hand slowly pours tea into a white cup, with a thin steady stream and gentle steam. "
    "Soft constant daylight, neutral white balance, natural colors, consistent exposure. "
    "Quiet room ambience and the sound of pouring tea. No cuts, no camera movement."
)


def arguments():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--enable-latent-extend", action="store_true", required=True)
    p.add_argument("--output-dir", type=Path, required=True)
    p.add_argument("--base-archive", type=Path)
    p.add_argument("--prompt", default=DEFAULT_PROMPT)
    p.add_argument("--seed", type=int, default=4242)
    p.add_argument("--segments", type=int, default=4, help="Includes the shared initial segment")
    p.add_argument("--frames", type=int, default=124)
    p.add_argument("--overlap", type=int, default=22)
    p.add_argument("--width", type=int, default=960)
    p.add_argument("--height", type=int, default=544)
    p.add_argument("--steps", type=int, choices=range(4, 11), default=8)
    p.add_argument("--attention", choices=["dense", "auto", "veda"], default="dense")
    p.add_argument("--tone-strength", type=float, default=0.25)
    p.add_argument("--mode", choices=["all", "baseline", "latent", "corrected"], default="all")
    p.add_argument("--verify-redecode", action="store_true")
    return p.parse_args()


def run(args):
    _validate_experiment_geometry(args.width, args.height, args.frames, args.overlap)
    if not args.output_dir.is_absolute() or not 2 <= args.segments <= 8:
        raise ValueError("Absolute output directory and 2..8 segments are required")
    if not 0 <= args.tone_strength <= 1:
        raise ValueError("Tone strength must be 0..1")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report_path = args.output_dir / "results.json"
    if report_path.exists():
        raise ValueError("Output directory already has results.json; choose a new experiment directory")
    report = {"status": "running", "config": {k: str(v) if isinstance(v, Path) else v
                                                for k, v in vars(args).items()}, "modes": {},
              "comparison": {"shared_initial_segment": True, "seed_strategy": "base seed + segment index",
                             "added_frames_per_segment": args.frames - args.overlap,
                             "baseline": "last decoded retained frame -> PNG -> VAE Encode; one frame trimmed; unused generated tail discarded",
                             "latent": "raw phase-aligned AV context; independently denoised overlap discarded; assembled native VAE decode",
                             "correction": "bounded per-channel latent mean-shift proxy, not calibrated RGB brightness",
                             "limitations": "one prompt/seed; metrics do not prove semantic or perceptual quality"}}

    def persist():
        temporary = report_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, report_path)

    def progress(value, stage):
        print(f"H3_LATENT_STAGE {stage} {value:.2f}", flush=True)

    def sample(previous=None, tone_reference=None, conditions=None, seed=None):
        req = GenerateRequest(prompt=args.prompt, task="fl2va" if conditions else "t2va",
                              conditions=conditions or [], target={"duration_seconds": max(4, min(15, args.frames / 24))},
                              quality_mode="preview",
                              seed=args.seed if seed is None else seed, num_inference_steps=args.steps,
                              attention_mode=args.attention)
        return runtime.sample_latent_segment(
            req, args.output_dir / "latents", previous_archive=previous,
            tone_reference_archive=tone_reference, overlap_frames=args.overlap,
            tone_strength=args.tone_strength if tone_reference else 0.0,
            width=args.width, height=args.height, frames=args.frames, stage_callback=progress,
        )

    runtime = MatlowRuntime(Settings.from_env())
    persist()
    try:
        report["probe"] = runtime.probe()
        persist()
        if not report["probe"].get("ready"):
            raise RuntimeError(report["probe"].get("reason"))
        if args.base_archive:
            base = args.base_archive
            _, _, manifest = read_h3_latent(base)
            if any(manifest[key] != getattr(args, key) for key in ("frames", "width", "height", "seed")):
                raise ValueError("Shared base archive geometry/seed does not match experiment")
            report["base"] = {"archive_path": str(base), "reused": True}
        else:
            report["base"] = sample()
            base = Path(report["base"]["archive_path"])
        persist()
        base_images, base_audio, report["base_decode"] = decode_h3_archive(runtime, base)
        save_h3_video(runtime, base_images, base_audio, args.output_dir / "base.mp4")
        if args.verify_redecode:
            again, audio_again, _ = decode_h3_archive(runtime, base)
            torch = runtime._imports()["torch"]
            report["restore_decode_check"] = {
                "video_equal": bool(torch.equal(base_images, again)),
                "video_max_abs": float((base_images - again).abs().max()),
                "audio_equal": bool(torch.equal(base_audio["waveform"], audio_again["waveform"])),
                "audio_max_abs": float((base_audio["waveform"] - audio_again["waveform"]).abs().max()),
            }
            report["restore_decode_check"]["status"] = (
                "passed" if report["restore_decode_check"]["video_equal"]
                and report["restore_decode_check"]["audio_equal"] else "failed"
            )
            if report["restore_decode_check"]["status"] != "passed":
                raise RuntimeError("Repeated archive VAE decode was not identical; see restore_decode_check measurements")
            del again, audio_again
        persist()
        modes = ("baseline", "latent", "corrected") if args.mode == "all" else (args.mode,)
        torch = runtime._imports()["torch"]
        for mode in modes:
            print(f"H3_LATENT_MODE {mode}", flush=True)
            entry = {"status": "running", "segments": [], "boundaries": []}
            report["modes"][mode] = entry
            current = base
            delivered_images, delivered_audio = [base_images], [base_audio["waveform"]]
            for index in range(1, args.segments):
                conditions = None
                if mode == "baseline":
                    from PIL import Image
                    last_frame = args.output_dir / f"baseline-keyframe-{index}.png"
                    rgb = delivered_images[-1][-1].clamp(0, 1).mul(255).round().byte().numpy()
                    Image.fromarray(rgb).save(last_frame)
                    conditions = [{"type": "image", "role": "keyframe", "frame_index": 0,
                                   "uri": last_frame.as_uri()}]
                segment = sample(previous=current if mode != "baseline" else None,
                                 tone_reference=base if mode == "corrected" else None,
                                 conditions=conditions, seed=(args.seed + index) % 2**31)
                entry["segments"].append(segment)
                persist()
                new = Path(segment["archive_path"])
                if mode == "baseline":
                    images, audio, decoded = decode_h3_archive(runtime, new)
                    save_h3_video(runtime, images, audio, args.output_dir / f"baseline-segment-{index}.mp4")
                    # Pixel Extend repeats one first frame. Keep the same number
                    # of delivered frames as AV Extend; discard the unused tail.
                    # The next keyframe is the last retained frame, never the
                    # discarded end of the generated clip.
                    entry["boundaries"].append(sum(x.shape[0] for x in delivered_images))
                    added_frames = args.frames - args.overlap
                    delivered_images.append(images[1:1 + added_frames])
                    trim_pcm = round(audio["sample_rate"] / 24)
                    kept_pcm = added_frames * audio["sample_rate"] // 24
                    delivered_audio.append(audio["waveform"][..., trim_pcm:trim_pcm + kept_pcm])
                    segment["discarded_generated_tail_frames"] = args.overlap - 1
                    segment["decode"] = decoded
                else:
                    old_v, old_a, old_m = read_h3_latent(current)
                    new_v, new_a, new_m = read_h3_latent(new)
                    joined_v, joined_a, joined_m = stitch_h3_latents(old_v, old_a, old_m, new_v, new_a, new_m,
                                                                  overlap_frames=args.overlap)
                    entry["boundaries"].append(old_m["frames"])
                    current = save_h3_latent({"samples": (joined_v, joined_a)}, args.output_dir / "latents",
                                             seed=args.seed, model_variant=joined_m["model_variant"],
                                             frames=joined_m["frames"], width=joined_m["width"],
                                             height=joined_m["height"], vae_mode=joined_m["vae_mode"],
                                             latent_extend=joined_m["latent_extend"])
                    segment["assembled_archive"] = str(current)
                    segment["assembled_frames"] = joined_m["frames"]
                    segment["stitch"] = {"added_frames": args.frames - args.overlap,
                                          "added_audio_cells": (args.frames - args.overlap) * 5 // 3}
                    del old_v, old_a, new_v, new_a, joined_v, joined_a
                persist()
            if mode == "baseline":
                final_images = torch.cat(delivered_images)
                final_audio = {"waveform": torch.cat(delivered_audio, dim=-1), "sample_rate": 32000}
            else:
                final_images, final_audio, entry["assembled_decode"] = decode_h3_archive(runtime, current)
                entry["final_archive"] = str(current)
            output = args.output_dir / f"{mode}.mp4"
            save_h3_video(runtime, final_images, final_audio, output)
            entry["output_video"] = str(output)
            entry["metrics"] = measure_video(final_images, entry["boundaries"], audio=final_audio["waveform"],
                                             audio_sample_rate=final_audio["sample_rate"])
            entry["status"] = "passed"
            persist()
            del final_images, final_audio, delivered_images, delivered_audio
        report["status"] = "passed"
        persist()
        print("H3_LATENT_BENCHMARK_PASS " + str(report_path), flush=True)
    except BaseException as exc:
        report["status"] = "failed"
        report["error"] = f"{type(exc).__name__}: {exc}"
        report["traceback"] = traceback.format_exc()
        persist()
        raise
    finally:
        runtime.unload()


if __name__ == "__main__":
    run(arguments())
