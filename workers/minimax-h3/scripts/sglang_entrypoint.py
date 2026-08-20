"""Select an explicit SGLang precision profile and fail closed on INT8 errors."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

PROFILES = {"bf16_offload", "kitchen_int8"}


def _quantization_value(arguments: list[str]) -> str | None:
    for index, argument in enumerate(arguments):
        if argument == "--quantization":
            if index + 1 >= len(arguments):
                raise RuntimeError("--quantization requires a value")
            return arguments[index + 1]
        if argument.startswith("--quantization="):
            return argument.partition("=")[2]
    return None


def prepare_command(profile: str, arguments: list[str]) -> list[str]:
    if profile not in PROFILES:
        raise RuntimeError("H3_SGLANG_PRECISION_PROFILE must be bf16_offload or kitchen_int8")
    quantization = _quantization_value(arguments)
    if profile == "kitchen_int8":
        if quantization not in {None, "kitchen_int8"}:
            raise RuntimeError(f"kitchen_int8 profile conflicts with --quantization {quantization!r}")
        if quantization is None:
            arguments = [*arguments, "--quantization", "kitchen_int8"]
    elif quantization == "kitchen_int8":
        raise RuntimeError("--quantization kitchen_int8 requires H3_SGLANG_PRECISION_PROFILE=kitchen_int8")
    return ["sglang", "serve", *arguments]


def main() -> int:
    profile = os.getenv("H3_SGLANG_PRECISION_PROFILE", "bf16_offload").strip().lower()
    command = prepare_command(profile, sys.argv[1:])
    if profile == "kitchen_int8":
        self_test = Path(__file__).with_name("kitchen_selftest.py")
        print(
            "kitchen_int8 explicitly selected; running mandatory CUDA kernel self-test; "
            "failure will stop startup (no BF16 fallback)",
            flush=True,
        )
        subprocess.run([sys.executable, str(self_test)], check=True)
    else:
        print("BF16 offload profile explicitly selected; kitchen_int8 is disabled", flush=True)
    os.execvp(command[0], command)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
