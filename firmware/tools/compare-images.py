#!/usr/bin/env python3
"""Checks that two ESP Lab Runtime app images (esplab-runtime*.app.bin) hold the same firmware.

Builds are reproducible except for the SHA-256 of the ELF file that ESP-IDF stamps into the app
descriptor (it covers debug information, which records build paths), and the image's checksum
byte and trailing SHA-256, which cover that field. Everything else, all code and data, must match.

    python3 firmware/tools/compare-images.py ci/esplab-runtime.app.bin downloaded.app.bin
"""
import sys

ELF_SHA = slice(0xB0, 0xD0)  # esp_app_desc_t.app_elf_sha256: header 0x18 + segment header 8 + offset 0x90


def normalized(path: str) -> bytes:
    data = bytearray(open(path, "rb").read())
    if data[0] != 0xE9:
        sys.exit(f"{path}: not an ESP app image")
    data[ELF_SHA] = bytes(32)
    if data[23] == 1:  # SHA-256 appended, after the 1-byte checksum (both cover the ELF hash)
        data[-33:] = bytes(33)
    else:
        data[-1] = 0
    return bytes(data)


a, b = (normalized(p) for p in sys.argv[1:3])
if a == b:
    print(f"same firmware ({len(a)} bytes; only the embedded ELF hash and the image hash differ, if anything)")
else:
    first = next(i for i in range(min(len(a), len(b))) if a[i] != b[i]) if len(a) == len(b) else None
    sys.exit(f"different firmware: sizes {len(a)} / {len(b)}" + (f", first difference at {first:#x}" if first is not None else ""))
