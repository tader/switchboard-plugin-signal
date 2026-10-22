#!/usr/bin/env python3
"""Build a checksum-pinned, symlink-free private JVM runtime bundle."""
import argparse, hashlib, json, os, platform, shutil, subprocess, tarfile, zipfile
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
PINS = json.loads(Path("runtime-pins.json").read_text())
LOCAL = ROOT / ".local"
DOWNLOADS = LOCAL / "downloads"
def fetch(pin):
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    dest = DOWNLOADS / (pin["sha256"] + ".tar.gz")
    if not dest.exists():
        partial = dest.with_suffix(".partial")
        subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error", "--retry", "3",
                        "--max-time", "600", "--output", str(partial), pin["url"]], check=True)
        partial.rename(dest)
    with dest.open("rb") as f:
        actual = hashlib.file_digest(f, "sha256").hexdigest()
    if actual != pin["sha256"]:
        dest.unlink()
        raise RuntimeError("Pinned upstream checksum mismatch")
    return dest
def extract(archive, dest):
    if dest.exists(): shutil.rmtree(dest)
    dest.mkdir(parents=True)
    with tarfile.open(archive) as t: t.extractall(dest, filter="data")
    children = list(dest.iterdir())
    if len(children) != 1 or not children[0].is_dir(): raise RuntimeError("Expected one upstream distribution directory")
    return children[0]
def prepare_arm():
    return extract(fetch(PINS["sources"]["libsignal-source.tar.gz"]), LOCAL / "build-sources/libsignal")
def build(key):
    dist = extract(fetch(PINS["signalCli"]), LOCAL / "extract-signal")
    java = extract(fetch(PINS["java"][key]), LOCAL / "extract-java")
    if key.startswith("darwin"): java = java / "Contents/Home"
    out = LOCAL / "runtime/runtime"
    if out.parent.exists(): shutil.rmtree(out.parent)
    out.mkdir(parents=True)
    shutil.copytree(dist, out / "signal-cli", symlinks=False)
    shutil.copytree(java, out / "jre", symlinks=False)
    if key == "linux-arm64":
        library = LOCAL / "libsignal/libsignal_jni_aarch64.so"
        if not library.is_file(): raise RuntimeError("Build the Debian-compatible ARM64 JNI library with scripts/build-arm64.sh first")
        jar = out / ("signal-cli/lib/libsignal-client-" + PINS["libsignalVersion"] + ".jar")
        with zipfile.ZipFile(jar, "a", compression=zipfile.ZIP_DEFLATED) as z:
            z.write(library, "libsignal_jni_aarch64.so")
    (out / "runtime-versions.json").write_text(json.dumps({k:PINS[k] for k in ["signalCliVersion","javaVersion","libsignalVersion"]},indent=2)+"\n")
    shutil.copy("NOTICE.md", out / "NOTICE.md")
    shutil.copy("runtime-pins.json", out / "runtime-pins.json")
    release = LOCAL / "release"; release.mkdir(parents=True,exist_ok=True)
    archive = release / ("signal-runtime-" + key + ".tar.gz")
    with tarfile.open(archive,"w:gz",dereference=True) as t: t.add(out, arcname="runtime")
    print("Built " + str(archive), flush=True)
def sources():
    release = LOCAL / "release"; release.mkdir(parents=True,exist_ok=True)
    stage = LOCAL / "corresponding-sources"; stage.mkdir(parents=True,exist_ok=True)
    for name,pin in PINS["sources"].items(): shutil.copy(fetch(pin),stage / name)
    for name in ["runtime-pins.json","NOTICE.md"]: shutil.copy(name,stage/name)
    shutil.copytree("scripts",stage/"build-scripts",dirs_exist_ok=True)
    with tarfile.open(release/"corresponding-sources.tar.gz","w:gz",dereference=True) as t: t.add(stage,arcname="sources")
if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--platform",choices=list(PINS["java"]))
    parser.add_argument("--prepare-arm",action="store_true")
    parser.add_argument("--sources",action="store_true")
    args=parser.parse_args()
    if args.prepare_arm: print(prepare_arm(),flush=True)
    elif args.sources: sources()
    else:
        key=args.platform or ("darwin" if platform.system()=="Darwin" else "linux")+"-"+("arm64" if platform.machine() in ["arm64","aarch64"] else "amd64")
        build(key)
