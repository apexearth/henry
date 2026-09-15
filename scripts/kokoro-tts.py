# /// script
# requires-python = ">=3.10"
# dependencies = ["kokoro-onnx>=0.6"]
# ///
"""Kokoro as Henry's voice: text on stdin, a WAV on stdout.

The daemon's `voice.tts` runs one process per answer, so this has to be cheap to start. The
inline metadata above lets uv own the environment (`uv run scripts/kokoro-tts.py`): the first
run installs kokoro-onnx and onnxruntime into uv's cache, every run after that is a warm start.
On a CPU an answer costs about half a second of startup, a second and a half to load the model
and then roughly a quarter of the audio's length to render it.

The model files are not fetched here. Download `kokoro-v1.0.onnx` and `voices-v1.0.bin` from
https://github.com/thewh1teagle/kokoro-onnx/releases into --dir (default:
%LOCALAPPDATA%/Programs/kokoro on Windows, ~/.local/share/kokoro elsewhere). The int8 model is
not a shortcut: on a CPU it is ten times slower than the full one.

config.json:  "tts": "uv run C:/path/to/henry/scripts/kokoro-tts.py --voice am_michael"
"""
import argparse
import io
import os
import sys
import wave
from pathlib import Path


def default_dir() -> Path:
    if sys.platform == "win32":
        return Path(os.environ["LOCALAPPDATA"]) / "Programs" / "kokoro"
    return Path.home() / ".local" / "share" / "kokoro"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--voice", default="af_heart", help="af_heart, af_sarah, af_bella, am_michael, am_adam, bf_emma, bm_george, ...")
    ap.add_argument("--speed", type=float, default=1.0, help="multiplier around 1.0")
    ap.add_argument("--dir", type=Path, default=default_dir(), help="folder holding the model and voices files")
    args = ap.parse_args()

    text = sys.stdin.read().strip()
    if not text:
        print("kokoro-tts: no text on stdin", file=sys.stderr)
        return 1
    model, voices = args.dir / "kokoro-v1.0.onnx", args.dir / "voices-v1.0.bin"
    for f in (model, voices):
        if not f.exists():
            print(f"kokoro-tts: {f} is missing (see the header of this script)", file=sys.stderr)
            return 1

    # Imported after the checks so a missing model file is reported in a millisecond rather
    # than after onnxruntime has loaded.
    import numpy as np
    from kokoro_onnx import Kokoro

    kokoro = Kokoro(str(model), str(voices))
    samples, rate = kokoro.create(text, voice=args.voice, speed=args.speed, lang="en-us")
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()

    # Built in memory: wave patches the header sizes by seeking, and a pipe cannot seek.
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    sys.stdout.buffer.write(buf.getvalue())
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
