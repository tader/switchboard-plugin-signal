# Third-party runtime notices

The Switchboard adapter is maintained in this repository. Runtime bundles distribute:

- signal-cli 0.14.9, copyright its contributors, GPL-3.0: https://github.com/AsamK/signal-cli/tree/v0.14.9
- libsignal 0.103.0, copyright Signal Messenger LLC and contributors, AGPL-3.0-only: https://github.com/signalapp/libsignal/tree/v0.103.0
- Eclipse Temurin OpenJDK JRE 25.0.4.1+1, GPL-2.0 with Classpath Exception and accompanying notices: https://github.com/adoptium/temurin25-binaries/releases/tag/jdk-25.0.4.1%2B1

All upstream license files, jar metadata and the JRE legal directory are retained. Linux ARM64 bundles add the matching libsignal JNI library compiled from the pinned source against Debian Bookworm. The remaining distributions use upstream native libraries.

Each plugin release includes corresponding-sources.tar.gz with pinned source archives, checksums and these build scripts. Runtime source URLs and SHA-256 values are recorded in runtime-pins.json. Dependencies retain their upstream attribution and license notices. Runtime files are separate subprocess components; linked-device sessions are user-generated data and are never included in releases.

The adapter reuses validation and loopback-adapter patterns from tader/switchboard-plugin-whatsapp, maintained by the same author. The Signal icon is an original generic chat illustration.
