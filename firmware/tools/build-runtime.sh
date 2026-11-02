#!/usr/bin/env bash
# Builds ESP Lab Recovery and the ESP Lab Runtime in the ESP-IDF container, for one or more chips:
#   TARGETS="esp32 esp32s3 esp32c3" firmware/tools/build-runtime.sh     (default: esp32)
# Writes, per chip, in firmware/esplab-runtime/build (esp32) or build-<chip>:
#   esplab-runtime.app.bin    app image for Tasmota's "Firmware Upgrade" / OtaUrl and our firmware OTA
#   esplab-runtime.merged.bin 4 MB USB image: bootloader, partitions, otadata -> app0, Recovery in
#                             the factory slot, the runtime in app0
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/firmware"
TARGETS="${TARGETS:-esp32}"
docker run --rm -e TARGETS="$TARGETS" -v "$PWD":/fw -w /fw espressif/idf:v5.5 bash -c '
  . $IDF_PATH/export.sh >/dev/null 2>&1
  for t in $TARGETS; do
    if [ "$t" = esp32 ]; then dir=build; boot=0x1000; else dir=build-$t; boot=0x0; fi
    args="-B $dir"
    [ "$t" = esp32 ] || args="$args -D SDKCONFIG=$dir/sdkconfig -D IDF_TARGET=$t"
    (cd esplab-recovery && idf.py $args build > $dir.log 2>&1) || { echo "[$t] recovery failed"; grep -E "error" esplab-recovery/$dir.log | head -20; exit 1; }
    cd esplab-runtime
    idf.py $args build > $dir.log 2>&1 || { echo "[$t] runtime failed"; grep -E "error|Error" $dir.log | head -30; exit 1; }
    cd $dir
    cp esplab-runtime.bin esplab-runtime.app.bin
    python3 /fw/tools/otadata.py 0 otadata-app0.bin
    esptool.py --chip $t merge_bin -o esplab-runtime.merged.bin --fill-flash-size 4MB \
      --flash_mode dio --flash_freq 40m --flash_size 4MB \
      $boot bootloader/bootloader.bin 0x8000 partition_table/partition-table.bin \
      0xE000 otadata-app0.bin 0x10000 /fw/esplab-recovery/$dir/esplab-recovery.bin \
      0xE0000 esplab-runtime.app.bin >/dev/null
    echo "[$t] recovery: $(stat -c %s /fw/esplab-recovery/$dir/esplab-recovery.bin) bytes (slot 0xD0000 = 851968)"
    echo "[$t] app image: $(stat -c %s esplab-runtime.app.bin) bytes (slot 0x2D0000 = 2949120)"
    cd /fw
  done
' 2>&1 | grep -vE "^\*|Checking|Python|detected|Activating|IDF_PATH|^Done|Go to|idf.py build|^$"
