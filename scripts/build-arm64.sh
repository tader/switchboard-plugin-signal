#!/usr/bin/env bash
# Build against Debian Bookworm so the result runs inside Switchboard's image.
set -euo pipefail
python3 scripts/build-runtime.py --prepare-arm
mkdir -p .local/libsignal
docker run --rm \
  -v "$PWD:/work" -v "$HOME/.cargo:/cargo" -v "$HOME/.rustup:/rustup" \
  -e CARGO_HOME=/cargo -e RUSTUP_HOME=/rustup -e PATH=/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  -e OUTPUT_UID="$(id -u)" -e OUTPUT_GID="$(id -g)" \
  -w /work/.local/build-sources/libsignal/libsignal-0.103.0 debian:bookworm-slim \
  bash -ceu '
    apt-get update
    apt-get install -y --no-install-recommends build-essential clang cmake pkg-config protobuf-compiler libprotobuf-dev libclang-dev curl ca-certificates python3 git
    cp /work/scripts/protoc.sh /usr/local/bin/protoc
    chmod 755 /usr/local/bin/protoc
    export PROTOC=/usr/local/bin/protoc
    bash java/build_jni.sh desktop
    cp java/client/src/main/resources/libsignal_jni_aarch64.so /work/.local/libsignal/
    strip --strip-unneeded /work/.local/libsignal/libsignal_jni_aarch64.so
    chown -R "$OUTPUT_UID:$OUTPUT_GID" /work/.local
  '
