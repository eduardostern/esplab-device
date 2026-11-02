# ESP Lab device software

The open-source half of [ESP Lab](https://esp-lab.stern.workers.dev): everything that runs on, or talks
to, an ESP32 device.

| Folder | What it is |
|---|---|
| `firmware/esplab-runtime` | **ESP Lab Runtime**: ESP-IDF 5.5 firmware that runs programs compiled to WebAssembly (WAMR interpreter), with Wi-Fi, the cloud link, program and firmware OTA with rollback, a local control page, and drivers' low level (I2C, UART, SPI, 1-Wire). ESP32, ESP32-S3, ESP32-C3. |
| `firmware/esplab-recovery` | **ESP Lab Recovery**: the small factory app that installs firmware updates and provides setup mode. |
| `packages/runtime-sdk` | The AssemblyScript libraries programs use: `esp` (pins, timers), `lab` (state machines, values, settings, commands, relays with interlocks and failsafes) and `io` (Modbus RTU, DS18B20, ADS1115, PCF8574/8575, LoRa, Pentair pumps and heat pumps, MD380 VFDs); program packing and the scenario test runner. |
| `packages/protocol` | `elp/1`, the JSON protocol between devices, the hub and apps. |
| `packages/client` | `@esplab/client`: connect websites, apps and servers to devices on a hub. |

The ESP Lab IDE, AI assistant, hub, dashboards and billing are a hosted service and are not part
of this repository. You can still run the firmware against your own server: it speaks `elp/1` over
a WebSocket (see `packages/protocol`).

## Build the firmware
With Docker (uses the `espressif/idf:v5.5` image):

    TARGETS="esp32 esp32s3 esp32c3" firmware/tools/build-runtime.sh

Each chip gets `esplab-runtime.app.bin` (for OTA and Tasmota's "Firmware Upgrade") and
`esplab-runtime.merged.bin` (a 4 MB image to flash over USB) in `firmware/esplab-runtime/build*`.
CI builds the same images on every push and publishes their SHA-256, so you can check that the
images served by ESP Lab match this source.

## Programs and tests

    npm install
    npm test -w @esp/runtime-sdk

Programs are AssemblyScript using the `lab` and `io` libraries; the tests compile real programs
and run them against simulated hardware (Modbus slaves, DS18B20 probes, LoRa radios, I2C chips).

## License
Apache License 2.0 (see `LICENSE` in each folder and `NOTICE`). "ESP Lab" is a trademark: forks
must use another name. Security issues: see `SECURITY.md`.
