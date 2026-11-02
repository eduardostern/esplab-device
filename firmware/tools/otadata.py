"""Writes an otadata image (2 x 4 KiB sectors) that boots app slot ota_<slot> and marks it valid.

usage: otadata.py <slot> <out.bin>
"""
import struct, sys, zlib

slot = int(sys.argv[1])
seq = slot + 1  # the bootloader boots ota_((seq - 1) % ota_count)
entry = struct.pack('<I', seq) + b'\xff' * 20 + struct.pack('<I', 2)  # ota_state 2 = VALID
entry += struct.pack('<I', zlib.crc32(struct.pack('<I', seq), 0xFFFFFFFF))
image = bytearray(b'\xff' * 0x2000)
image[0:len(entry)] = entry
open(sys.argv[2], 'wb').write(image)
