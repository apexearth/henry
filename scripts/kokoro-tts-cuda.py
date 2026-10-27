# /// script
# requires-python = ">=3.10"
# dependencies = ["kokoro-onnx>=0.6", "onnxruntime-gpu[cuda,cudnn]>=1.21", "onnx>=1.17"]
# [tool.uv]
# override-dependencies = ["onnxruntime; sys_platform == 'never'"]
# ///
"""Kokoro on an NVIDIA card: kokoro-tts.py with CUDA, for Windows and Linux.

The override above drops the CPU onnxruntime that kokoro-onnx asks for, since both packages
install the same module. The cuda and cudnn extras bring the CUDA libraries as wheels (about
2 GB in uv's cache), so nothing is installed system-wide; a current NVIDIA driver is enough.

The stock kokoro-v1.0.onnx is a poor fit for a GPU: it expands durations in a Loop that runs once
per phoneme, which costs more on CUDA than the whole model does on a CPU. The onnx-community
export has no Loop but uses an STFT, which onnxruntime only runs on the CPU. `--prepare`
downloads that export and replaces its STFT with the equivalent strided Conv, writing
kokoro-v1.0.cuda.onnx next to voices-v1.0.bin (see kokoro-tts.py for that file and --dir).

Run `uv run scripts/kokoro-tts-cuda.py --prepare` once by hand: the first run also installs the
environment, which takes longer than the daemon waits for an answer.

config.json:  "tts": "uv run C:/path/to/henry/scripts/kokoro-tts-cuda.py --voice af_heart"
"""
import importlib.util
import sys
from pathlib import Path

MODEL = "kokoro-v1.0.cuda.onnx"
SOURCE = (
    "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/"
    "1939ad2a8e416c0acfeecc08a694d14ef25f2231/onnx/model.onnx"
)


def cpu_script():
    spec = importlib.util.spec_from_file_location("kokoro_tts", Path(__file__).with_name("kokoro-tts.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def open_session(path: str):
    import onnxruntime as rt

    rt.preload_dlls()  # the CUDA wheels are not on PATH
    rt.set_default_logger_severity(3)  # it warns about Memcpy and ScatterND on every run
    session = rt.InferenceSession(path, providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    if session.get_providers()[0] != "CUDAExecutionProvider":
        print("kokoro-tts-cuda: CUDA did not load, running on the CPU", file=sys.stderr)
    return session


def stft_as_conv(model) -> None:
    """Swap the STFT node for a Conv whose kernels are the windowed DFT basis."""
    import numpy as np
    from onnx import helper, numpy_helper

    g = model.graph
    inits = {i.name: i for i in g.initializer}
    idx, stft = next((i, n) for i, n in enumerate(g.node) if n.op_type == "STFT")
    assert [a.i for a in stft.attribute if a.name == "onesided"] == [1]
    hop = int(numpy_helper.to_array(inits[stft.input[1]]))
    window = numpy_helper.to_array(inits[stft.input[2]]).astype(np.float64)
    nfft = int(numpy_helper.to_array(inits[stft.input[3]]))
    bins = nfft // 2 + 1

    angle = 2 * np.pi * np.arange(bins)[:, None] * np.arange(nfft) / nfft
    sin = np.sin(angle)
    # The model feeds atan2(imag, real) to the network, so the DC and Nyquist bins must be exactly
    # real, as an FFT makes them: a rounding residue there flips their phase between +pi and -pi.
    sin[[0, -1] if nfft % 2 == 0 else [0]] = 0
    kernel = np.concatenate([window * np.cos(angle), -window * sin])[:, None, :].astype(np.float32)

    p = stft.name + "/as_conv"
    g.initializer.extend([
        numpy_helper.from_array(kernel, p + "/kernel"),
        numpy_helper.from_array(np.array([0, 1, -1], np.int64), p + "/signal_shape"),
        numpy_helper.from_array(np.array([0, 2, bins, -1], np.int64), p + "/spec_shape"),
    ])
    nodes = [
        helper.make_node("Reshape", [stft.input[0], p + "/signal_shape"], [p + "/signal"]),  # [B,1,L]
        helper.make_node("Conv", [p + "/signal", p + "/kernel"], [p + "/conv"], strides=[hop]),  # [B,2*bins,F]
        helper.make_node("Reshape", [p + "/conv", p + "/spec_shape"], [p + "/spec"]),  # [B,2,bins,F]
        helper.make_node("Transpose", [p + "/spec"], [stft.output[0]], perm=[0, 3, 2, 1]),  # [B,F,bins,2]
    ]
    del g.node[idx]
    for offset, node in enumerate(nodes):
        g.node.insert(idx + offset, node)


def prepare(folder: Path) -> int:
    import urllib.request

    import onnx
    from onnx import shape_inference

    folder.mkdir(parents=True, exist_ok=True)
    download = folder / "kokoro-v1.0.onnx-community.onnx"
    if not download.exists():
        print(f"kokoro-tts-cuda: downloading {SOURCE}", file=sys.stderr)
        part = download.with_suffix(".part")
        urllib.request.urlretrieve(SOURCE, part)
        part.replace(download)
    model = onnx.load(str(download))
    stft_as_conv(model)
    # The exporter's shape annotations no longer fit the new nodes, and with gaps in them
    # onnxruntime's allocation planner takes seconds longer on every load.
    del model.graph.value_info[:]
    model = shape_inference.infer_shapes(model, data_prop=True)
    onnx.checker.check_model(model)
    out = folder / MODEL
    onnx.save(model, str(out.with_suffix(".part")))
    out.with_suffix(".part").replace(out)
    download.unlink()
    print(f"kokoro-tts-cuda: wrote {out}", file=sys.stderr)
    if not (folder / "voices-v1.0.bin").exists():
        print(f"kokoro-tts-cuda: {folder / 'voices-v1.0.bin'} is still missing (see kokoro-tts.py)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    tts = cpu_script()
    if "--prepare" in sys.argv:
        import argparse

        ap = argparse.ArgumentParser(description="build " + MODEL)
        ap.add_argument("--prepare", action="store_true")
        ap.add_argument("--dir", type=Path, default=tts.default_dir())
        sys.exit(prepare(ap.parse_args().dir))
    sys.exit(tts.main(MODEL, open_session))
