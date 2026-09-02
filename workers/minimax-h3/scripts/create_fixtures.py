import struct
import wave
import zlib
from pathlib import Path


def png(path: Path, rgba: tuple[int, int, int, int]) -> None:
    width = height = 32
    raw = b"".join(b"\x00" + bytes(rgba) * width for _ in range(height))

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))
        )

    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    output = Path(__file__).resolve().parents[1] / "examples" / "fixtures"
    output.mkdir(parents=True, exist_ok=True)
    png(output / "first.png", (32, 96, 180, 255))
    png(output / "last.png", (180, 96, 32, 255))
    png(output / "reference.png", (96, 180, 32, 255))
    png(output / "mask.png", (255, 255, 255, 255))
    with wave.open(str(output / "reference.wav"), "wb") as target:
        target.setparams((1, 2, 8_000, 8_000, "NONE", "not compressed"))
        target.writeframes(b"\x00\x00" * 8_000)
    # Contract-only placeholder. Replace with an owned 4-15 second MP4 before GPU smoke tests.
    (output / "source-placeholder.mp4").write_bytes(
        struct.pack(">I4s4sI4s", 24, b"ftyp", b"isom", 0x200, b"isom") + struct.pack(">I4s", 8, b"mdat")
    )
    print(output)


if __name__ == "__main__":
    main()
