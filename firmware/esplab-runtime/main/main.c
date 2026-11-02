// ESP Lab Runtime: runs a WebAssembly program (exports setup() and loop()) on the ESP32 via WAMR.
//
// The program lives in the "program" flash partition as a blob:
//   offset 0  "ELRT"   magic
//   offset 4  u16      format version (1)
//   offset 6  u16      flags (0)
//   offset 8  u32      wasm length
//   offset 12 u32      CRC-32 (IEEE, zlib-compatible) of the wasm bytes
//   offset 16 ...      wasm module
// The emulator writes the partition before boot. A running device takes new programs over the
// console UART:  "ESPLAB LOAD <len> <crc32-hex>", base64 lines, then it answers "ESPLAB OK".
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <sys/time.h>

#include "esp_pthread.h"

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/ledc.h"
#include "driver/uart.h"
#include "driver/spi_master.h"
#include "soc/soc_caps.h"
#if SOC_USB_SERIAL_JTAG_SUPPORTED
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#endif
#if CONFIG_SPIRAM
#include "esp_psram.h"
#endif
#include "esp_rom_sys.h"
#include "mbedtls/md.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_partition.h"
#include "esp_random.h"
#include "esp_rom_crc.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "esp_mac.h"
#include "nvs.h"
#include "freertos/task.h"
#include "mbedtls/base64.h"
#include "cJSON.h"
#include "labhost.h"

#include "esp_heap_caps.h"
#include "esp_ota_ops.h"
#include "esp_system.h"

#include "wasm_export.h"

#include "net.h"
#include "local.h"

void portal_start(void);

#ifndef RUNTIME_VERSION
#define RUNTIME_VERSION "0.13"
#endif
#define BLOB_MAGIC "ELRT"
#define BLOB_HEADER 16
#define VM_STACK_SIZE (8 * 1024)
#define VM_HEAP_SIZE 0  // AssemblyScript manages its own heap inside linear memory
#define CONSOLE_UART UART_NUM_0

static const char *chip_id(void);

// ---- console input ------------------------------------------------------------------------
//
// ESP Lab talks to the board over its console: UART0 (boards with a USB-serial chip) and, on
// chips with one, the built-in USB Serial/JTAG port (ESP32-S3/C3 boards with only a USB socket).
// Output goes to both (the secondary console); input is read from both.

static bool usb_console;

static void console_start(void) {
  uart_driver_install(CONSOLE_UART, 4096, 0, 0, NULL, 0);
#if SOC_USB_SERIAL_JTAG_SUPPORTED
  usb_serial_jtag_driver_config_t usb = {.rx_buffer_size = 4096, .tx_buffer_size = 1024};
  if (usb_serial_jtag_driver_install(&usb) == ESP_OK) {
    usb_serial_jtag_vfs_use_driver();
    usb_console = true;
  }
#endif
}

/** One byte from either console port, waiting up to `wait`. */
static bool console_read(uint8_t *c, TickType_t wait) {
  if (!usb_console) return uart_read_bytes(CONSOLE_UART, c, 1, wait) == 1;
#if SOC_USB_SERIAL_JTAG_SUPPORTED
  TickType_t slice = pdMS_TO_TICKS(10);
  TickType_t waited = 0;
  for (;;) {
    if (uart_read_bytes(CONSOLE_UART, c, 1, 0) == 1) return true;
    if (usb_serial_jtag_read_bytes(c, 1, slice) == 1) return true;
    waited += slice;
    if (wait != portMAX_DELAY && waited >= wait) return false;
  }
#else
  return false;
#endif
}

// ---- program storage ----------------------------------------------------------

// Our own layout has a "program" partition (subtype 0x40). On the Tasmota-compatible layout (and
// on a device converted from Tasmota) programs live in the spiffs/littlefs data partition.
static const esp_partition_t *program_partition(void) {
  static const esp_partition_t *cached;
  if (cached) return cached;
  cached = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, 0x40, NULL);
  if (!cached) cached = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_LITTLEFS, NULL);
  if (!cached) cached = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_SPIFFS, NULL);
  return cached;
}

static uint32_t rd32(const uint8_t *p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }
static void wr32(uint8_t *p, uint32_t v) { p[0] = v; p[1] = v >> 8; p[2] = v >> 16; p[3] = v >> 24; }

static uint32_t crc32_ieee(const uint8_t *data, size_t len) { return esp_rom_crc32_le(0, data, len); }

// ---- program slots --------------------------------------------------------------------------
//
// The program store holds two slots (A at 0, B at half the partition). A new program is written
// to the slot not in use, then becomes active. Programs deployed over the air start in "trial":
// if they stop (trap) or the board restarts within TRIAL_MS, the previous slot comes back.
#define TRIAL_MS 30000

static uint8_t active_slot;      // 0 = A, 1 = B
static bool trial;               // the active program is on trial (not yet confirmed)
static char trial_deploy[48];    // its deployment id, for the report
static char pending_report[160]; // a report to send once the cloud link is up

static size_t slot_size(const esp_partition_t *part) { return (part->size / 2) & ~(size_t)0xFFF; }
static size_t slot_base(const esp_partition_t *part, uint8_t slot) { return slot ? slot_size(part) : 0; }

static void slots_load(void) {
  nvs_handle_t h;
  if (nvs_open("esplab", NVS_READONLY, &h) != ESP_OK) return;
  uint8_t v = 0;
  if (nvs_get_u8(h, "slot", &v) == ESP_OK) active_slot = v ? 1 : 0;
  if (nvs_get_u8(h, "trial", &v) == ESP_OK) trial = v != 0;
  size_t n = sizeof(trial_deploy);
  if (nvs_get_str(h, "tdeploy", trial_deploy, &n) != ESP_OK) trial_deploy[0] = 0;
  nvs_close(h);
}

static void slots_save(void) {
  nvs_handle_t h;
  if (nvs_open("esplab", NVS_READWRITE, &h) != ESP_OK) return;
  nvs_set_u8(h, "slot", active_slot);
  nvs_set_u8(h, "trial", trial ? 1 : 0);
  nvs_set_str(h, "tdeploy", trial_deploy);
  nvs_commit(h);
  nvs_close(h);
}

/** Length and CRC of the program in a slot; false when the slot holds no valid header. */
static bool slot_header(const esp_partition_t *part, uint8_t slot, uint32_t *len, uint32_t *crc) {
  uint8_t header[BLOB_HEADER];
  if (esp_partition_read(part, slot_base(part, slot), header, sizeof(header)) != ESP_OK) return false;
  if (memcmp(header, BLOB_MAGIC, 4) != 0) return false;
  *len = rd32(header + 8);
  *crc = rd32(header + 12);
  return *len > 0 && *len <= slot_size(part) - BLOB_HEADER;
}

static bool write_slot_header(const esp_partition_t *part, uint8_t slot, uint32_t len, uint32_t crc) {
  uint8_t header[BLOB_HEADER] = {'E', 'L', 'R', 'T', 1, 0, 0, 0};
  wr32(header + 8, len);
  wr32(header + 12, crc);
  return esp_partition_write(part, slot_base(part, slot), header, sizeof(header)) == ESP_OK;
}

/** Reads and validates the active program. Returns a malloc'd wasm buffer or NULL. */
static uint8_t *load_program(uint32_t *out_len) {
  const esp_partition_t *part = program_partition();
  if (!part) {
    printf("[vm] no program partition in this firmware\n");
    return NULL;
  }
  uint32_t len = 0, crc = 0;
  if (!slot_header(part, active_slot, &len, &crc)) {
    uint32_t l2, c2;
    if (slot_header(part, active_slot ^ 1, &l2, &c2)) {
      active_slot ^= 1;  // the other slot holds the only valid program
      slots_save();
      len = l2;
      crc = c2;
    } else {
      printf("[vm] no program stored. Send one from ESP Lab.\n");
      return NULL;
    }
  }
  uint8_t *code = malloc(len);
  if (!code) {
    printf("[vm] not enough memory for a %lu byte program\n", (unsigned long)len);
    return NULL;
  }
  if (esp_partition_read(part, slot_base(part, active_slot) + BLOB_HEADER, code, len) != ESP_OK || crc32_ieee(code, len) != crc) {
    printf("[vm] stored program failed its checksum\n");
    free(code);
    return NULL;
  }
  *out_len = len;
  return code;
}

/** Writes a program (from the console loader) to the free slot and makes it active, trusted. */
static bool store_program(const uint8_t *wasm, uint32_t len, uint32_t crc) {
  const esp_partition_t *part = program_partition();
  if (!part || len > slot_size(part) - BLOB_HEADER) return false;
  uint8_t slot = active_slot ^ 1;
  size_t span = (BLOB_HEADER + len + 4095) & ~4095u;
  if (esp_partition_erase_range(part, slot_base(part, slot), span) != ESP_OK) return false;
  if (esp_partition_write(part, slot_base(part, slot) + BLOB_HEADER, wasm, len) != ESP_OK) return false;
  // Header last: a power cut mid-write leaves no valid magic rather than a half program.
  if (!write_slot_header(part, slot, len, crc)) return false;
  active_slot = slot;
  trial = false;
  trial_deploy[0] = 0;
  slots_save();
  return true;
}

// Program memory arena (see reserve_arena).
static uint8_t *arena;
static size_t arena_size;
static bool arena_used;

// ---- VM state shared with the loader ------------------------------------------------------

static SemaphoreHandle_t reload_signal;            // given when a new program is stored
static volatile wasm_module_inst_t running_inst;   // instance currently executing, if any
static volatile bool reload_requested;
static volatile bool vm_idle;                      // true while the VM waits for reload_signal

// ---- host API: module "esp" ---------------------------------------------------------------

/**
 * Pins wired to the flash (and octal PSRAM) inside the module: touching them stops the chip, so
 * programs may not use them.
 */
static bool reserved_pin(int32_t pin) {
#if CONFIG_IDF_TARGET_ESP32
  return pin >= 6 && pin <= 11;
#elif CONFIG_IDF_TARGET_ESP32S3
  return (pin >= 26 && pin <= 32)
#if CONFIG_SPIRAM_MODE_OCT
         || (pin >= 33 && pin <= 37 && esp_psram_is_initialized())
#endif
      ;
#elif CONFIG_IDF_TARGET_ESP32C3
  return pin >= 12 && pin <= 17;
#else
  return false;
#endif
}

static bool valid_pin(int32_t pin) {
  if (pin < 0 || pin >= GPIO_NUM_MAX || !GPIO_IS_VALID_GPIO(pin)) return false;
  if (reserved_pin(pin)) {
    static uint64_t warned;
    if (!(warned & (1ULL << pin))) {
      warned |= 1ULL << pin;
      printf("[vm] GPIO %ld is wired to the flash inside the module: not available to programs\n", (long)pin);
    }
    return false;
  }
  return true;
}

static void esp_pin_mode(wasm_exec_env_t env, int32_t pin, int32_t mode) {
  if (!valid_pin(pin)) return;
  gpio_reset_pin((gpio_num_t)pin);
  // 0 INPUT, 1 OUTPUT, 2 INPUT_PULLUP, 3 INPUT_PULLDOWN (Arduino numbering differs; the SDK maps it)
  gpio_set_direction((gpio_num_t)pin, mode == 1 ? GPIO_MODE_INPUT_OUTPUT : GPIO_MODE_INPUT);
  if (mode == 2) gpio_set_pull_mode((gpio_num_t)pin, GPIO_PULLUP_ONLY);
  if (mode == 3) gpio_set_pull_mode((gpio_num_t)pin, GPIO_PULLDOWN_ONLY);
}

static void esp_digital_write(wasm_exec_env_t env, int32_t pin, int32_t value) {
  if (valid_pin(pin)) gpio_set_level((gpio_num_t)pin, value ? 1 : 0);
}

static int32_t esp_digital_read(wasm_exec_env_t env, int32_t pin) {
  return valid_pin(pin) ? gpio_get_level((gpio_num_t)pin) : 0;
}

static void esp_delay(wasm_exec_env_t env, int32_t ms) {
  TickType_t ticks = pdMS_TO_TICKS(ms > 0 ? ms : 0);
  vTaskDelay(ticks ? ticks : 1);
}

static void esp_delay_us(wasm_exec_env_t env, int32_t us) {
  if (us > 0) esp_rom_delay_us(us > 100000 ? 100000 : us);
}

static int64_t esp_millis(wasm_exec_env_t env) { return esp_timer_get_time() / 1000; }
static int64_t esp_micros(wasm_exec_env_t env) { return esp_timer_get_time(); }
static int32_t esp_random_i(wasm_exec_env_t env, int32_t max) { return max > 0 ? (int32_t)(esp_random() % (uint32_t)max) : 0; }

// Strings arrive as UTF-16 (AssemblyScript's native encoding): pointer + byte length.
static void esp_print(wasm_exec_env_t env, const uint8_t *buf, uint32_t bytes) {
  char out[128];
  size_t n = 0;
  for (uint32_t i = 0; i + 2 <= bytes; i += 2) {
    uint16_t c = buf[i] | (buf[i + 1] << 8);
    if (c < 0x80) {
      out[n++] = (char)c;
    } else if (c < 0x800) {
      out[n++] = 0xC0 | (c >> 6);
      out[n++] = 0x80 | (c & 0x3F);
    } else {
      out[n++] = 0xE0 | (c >> 12);
      out[n++] = 0x80 | ((c >> 6) & 0x3F);
      out[n++] = 0x80 | (c & 0x3F);
    }
    if (n > sizeof(out) - 4) {
      fwrite(out, 1, n, stdout);
      n = 0;
    }
  }
  fwrite(out, 1, n, stdout);
  fflush(stdout);
}

// ADC: GPIO 32..39 on ADC1. Returns 0..4095.
static adc_oneshot_unit_handle_t adc1;

static int32_t esp_analog_read(wasm_exec_env_t env, int32_t pin) {
  adc_unit_t unit;
  adc_channel_t channel;
  if (adc_oneshot_io_to_channel(pin, &unit, &channel) != ESP_OK || unit != ADC_UNIT_1) return 0;
  if (!adc1) {
    adc_oneshot_unit_init_cfg_t cfg = {.unit_id = ADC_UNIT_1};
    if (adc_oneshot_new_unit(&cfg, &adc1) != ESP_OK) return 0;
  }
  adc_oneshot_chan_cfg_t ch = {.atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12};
  adc_oneshot_config_channel(adc1, channel, &ch);
  int raw = 0;
  adc_oneshot_read(adc1, channel, &raw);
  return raw;
}

// PWM (LEDC): analogWrite(pin, 0..255) at 5 kHz, one channel per pin, up to 8 pins (6 on C3).
#if SOC_LEDC_SUPPORT_HS_MODE
#define PWM_MODE LEDC_HIGH_SPEED_MODE
#else
#define PWM_MODE LEDC_LOW_SPEED_MODE
#endif
static int8_t ledc_pin_channel[GPIO_NUM_MAX];
static int ledc_next_channel;
static bool ledc_timer_ready;

static void esp_analog_write(wasm_exec_env_t env, int32_t pin, int32_t value) {
  if (!valid_pin(pin)) return;
  if (!ledc_timer_ready) {
    ledc_timer_config_t timer = {.speed_mode = PWM_MODE, .duty_resolution = LEDC_TIMER_8_BIT,
                                 .timer_num = LEDC_TIMER_0, .freq_hz = 5000, .clk_cfg = LEDC_AUTO_CLK};
    if (ledc_timer_config(&timer) != ESP_OK) return;
    memset(ledc_pin_channel, -1, sizeof(ledc_pin_channel));
    ledc_timer_ready = true;
  }
  if (ledc_pin_channel[pin] < 0) {
    if (ledc_next_channel >= LEDC_CHANNEL_MAX) return;
    ledc_channel_config_t ch = {.gpio_num = pin, .speed_mode = PWM_MODE, .channel = ledc_next_channel,
                                .timer_sel = LEDC_TIMER_0, .duty = 0};
    if (ledc_channel_config(&ch) != ESP_OK) return;
    ledc_pin_channel[pin] = ledc_next_channel++;
  }
  int duty = value < 0 ? 0 : value > 255 ? 255 : value;
  ledc_set_duty(PWM_MODE, ledc_pin_channel[pin], duty);
  ledc_update_duty(PWM_MODE, ledc_pin_channel[pin]);
}

// I2C master: i2cBegin(sda, scl, hz); write/read return 0 on success, negative on error.
static i2c_master_bus_handle_t i2c_bus;

static int32_t esp_i2c_begin(wasm_exec_env_t env, int32_t sda, int32_t scl, int32_t hz) {
  if (i2c_bus) return 0;
  if (!valid_pin(sda) || !valid_pin(scl)) return -1;
  i2c_master_bus_config_t cfg = {.i2c_port = I2C_NUM_0, .sda_io_num = sda, .scl_io_num = scl,
                                 .clk_source = I2C_CLK_SRC_DEFAULT, .glitch_ignore_cnt = 7,
                                 .flags.enable_internal_pullup = true};
  (void)hz;
  return i2c_new_master_bus(&cfg, &i2c_bus) == ESP_OK ? 0 : -2;
}

static i2c_master_dev_handle_t i2c_device(int32_t addr) {
  static i2c_master_dev_handle_t devices[128];
  if (!i2c_bus || addr < 0 || addr > 127) return NULL;
  if (!devices[addr]) {
    i2c_device_config_t dev = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = addr, .scl_speed_hz = 100000};
    if (i2c_master_bus_add_device(i2c_bus, &dev, &devices[addr]) != ESP_OK) return NULL;
  }
  return devices[addr];
}

static int32_t esp_i2c_write(wasm_exec_env_t env, int32_t addr, const uint8_t *data, uint32_t len) {
  i2c_master_dev_handle_t dev = i2c_device(addr);
  if (!dev) return -1;
  return i2c_master_transmit(dev, data, len, 50) == ESP_OK ? 0 : -2;
}

static int32_t esp_i2c_read(wasm_exec_env_t env, int32_t addr, uint8_t *data, uint32_t len) {
  i2c_master_dev_handle_t dev = i2c_device(addr);
  if (!dev) return -1;
  return i2c_master_receive(dev, data, len, 50) == ESP_OK ? 0 : -2;
}

// ---- serial ports (UART, RS-485) -----------------------------------------------------------
//
// uartOpen(port, baud, tx, rx, de, config): port 1 or 2 (the console is UART0; C3 has only 1).
// de >= 0 drives an RS-485 transceiver's DE/RE pin (half duplex, hardware-timed).
// config: 0 = 8N1, 1 = 8E1, 2 = 8O1, 3 = 8N2.

static bool uart_open[UART_NUM_MAX];

static int32_t esp_uart_open(wasm_exec_env_t env, int32_t port, int32_t baud, int32_t tx, int32_t rx, int32_t de, int32_t config) {
  if (port <= 0 || port >= UART_NUM_MAX || port == CONSOLE_UART) return -1;
  if (!valid_pin(tx) || !valid_pin(rx) || (de >= 0 && !valid_pin(de)) || baud < 300 || baud > 2000000) return -1;
  if (uart_open[port]) {
    uart_driver_delete(port);
    uart_open[port] = false;
  }
  uart_config_t cfg = {
    .baud_rate = baud,
    .data_bits = UART_DATA_8_BITS,
    .parity = config == 1 ? UART_PARITY_EVEN : config == 2 ? UART_PARITY_ODD : UART_PARITY_DISABLE,
    .stop_bits = config == 3 ? UART_STOP_BITS_2 : UART_STOP_BITS_1,
    .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
    .source_clk = UART_SCLK_DEFAULT,
  };
  if (uart_driver_install(port, 1024, 0, 0, NULL, 0) != ESP_OK) return -2;
  uart_open[port] = true;
  if (uart_param_config(port, &cfg) != ESP_OK ||
      uart_set_pin(port, tx, rx, de >= 0 ? de : UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) != ESP_OK) return -3;
  if (de >= 0 && uart_set_mode(port, UART_MODE_RS485_HALF_DUPLEX) != ESP_OK) return -4;
  return 0;
}

static int32_t esp_uart_write(wasm_exec_env_t env, int32_t port, const uint8_t *data, uint32_t len) {
  if (port <= 0 || port >= UART_NUM_MAX || !uart_open[port]) return -1;
  int n = uart_write_bytes(port, data, len);
  uart_wait_tx_done(port, pdMS_TO_TICKS(500));  // RS-485: the bus is released before a reply
  return n;
}

/** Reads up to cap bytes, waiting at most timeoutMs for the first; returns the count. */
static int32_t esp_uart_read(wasm_exec_env_t env, int32_t port, uint8_t *data, uint32_t cap, int32_t timeout_ms) {
  if (port <= 0 || port >= UART_NUM_MAX || !uart_open[port]) return -1;
  if (timeout_ms < 0) timeout_ms = 0;
  if (timeout_ms > 5000) timeout_ms = 5000;
  int n = uart_read_bytes(port, data, cap, pdMS_TO_TICKS(timeout_ms));
  return n < 0 ? -2 : n;
}

static int32_t esp_uart_available(wasm_exec_env_t env, int32_t port) {
  size_t n = 0;
  if (port <= 0 || port >= UART_NUM_MAX || !uart_open[port]) return -1;
  uart_get_buffered_data_len(port, &n);
  return (int32_t)n;
}

// ---- SPI master ----------------------------------------------------------------------------
//
// spiBegin(sclk, mosi, miso) starts SPI2; spiDevice(cs, hz, mode) adds a device (up to 3);
// spiTransfer(device, buffer, length) sends the bytes and replaces them with the bytes read.

static bool spi_ready;
static spi_device_handle_t spi_devices[3];

static int32_t esp_spi_begin(wasm_exec_env_t env, int32_t sclk, int32_t mosi, int32_t miso) {
  if (spi_ready) return 0;
  if (!valid_pin(sclk) || !valid_pin(mosi) || (miso >= 0 && !valid_pin(miso))) return -1;
  spi_bus_config_t bus = {.sclk_io_num = sclk, .mosi_io_num = mosi, .miso_io_num = miso,
                          .quadwp_io_num = -1, .quadhd_io_num = -1, .max_transfer_sz = 256};
  if (spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_DISABLED) != ESP_OK) return -2;
  spi_ready = true;
  return 0;
}

static int32_t esp_spi_device(wasm_exec_env_t env, int32_t cs, int32_t hz, int32_t mode) {
  if (!spi_ready || (cs >= 0 && !valid_pin(cs)) || hz <= 0 || mode < 0 || mode > 3) return -1;
  for (int i = 0; i < 3; i++) {
    if (spi_devices[i]) continue;
    spi_device_interface_config_t dev = {.clock_speed_hz = hz > 20000000 ? 20000000 : hz, .mode = mode,
                                         .spics_io_num = cs, .queue_size = 1};
    return spi_bus_add_device(SPI2_HOST, &dev, &spi_devices[i]) == ESP_OK ? i : -2;
  }
  return -3;
}

static int32_t esp_spi_transfer(wasm_exec_env_t env, int32_t device, uint8_t *data, uint32_t len) {
  if (device < 0 || device > 2 || !spi_devices[device] || len == 0 || len > 256) return -1;
  uint8_t rx[256];
  spi_transaction_t t = {.length = len * 8, .tx_buffer = data, .rx_buffer = rx};
  if (spi_device_polling_transmit(spi_devices[device], &t) != ESP_OK) return -2;
  memcpy(data, rx, len);
  return 0;
}

// ---- 1-Wire (DS18B20 and friends), bit-banged on any GPIO with the bus pulled up ----------
//
// Each time slot runs with interrupts off on this core (at most ~500 us for a reset).

static portMUX_TYPE ow_lock = portMUX_INITIALIZER_UNLOCKED;
static uint64_t ow_pins;  // pins already set up as open drain

static void ow_setup(int32_t pin) {
  if (ow_pins & (1ULL << pin)) return;
  gpio_reset_pin((gpio_num_t)pin);
  gpio_set_direction((gpio_num_t)pin, GPIO_MODE_INPUT_OUTPUT_OD);
  gpio_set_pull_mode((gpio_num_t)pin, GPIO_PULLUP_ONLY);
  gpio_set_level((gpio_num_t)pin, 1);
  ow_pins |= 1ULL << pin;
}

/** Reset pulse; 1 when a device answered with a presence pulse. */
static int32_t esp_ow_reset(wasm_exec_env_t env, int32_t pin) {
  if (!valid_pin(pin)) return -1;
  ow_setup(pin);
  portENTER_CRITICAL(&ow_lock);
  gpio_set_level((gpio_num_t)pin, 0);
  esp_rom_delay_us(480);
  gpio_set_level((gpio_num_t)pin, 1);
  esp_rom_delay_us(70);
  int presence = gpio_get_level((gpio_num_t)pin) == 0;
  portEXIT_CRITICAL(&ow_lock);
  esp_rom_delay_us(410);
  return presence;
}

static int ow_bit(int32_t pin, int bit) {
  portENTER_CRITICAL(&ow_lock);
  gpio_set_level((gpio_num_t)pin, 0);
  esp_rom_delay_us(bit ? 3 : 60);
  gpio_set_level((gpio_num_t)pin, 1);
  int read = 1;
  if (bit) {
    esp_rom_delay_us(9);
    read = gpio_get_level((gpio_num_t)pin);
    esp_rom_delay_us(50);
  } else {
    esp_rom_delay_us(5);
  }
  portEXIT_CRITICAL(&ow_lock);
  return read;
}

/** Writes one bit (1 = a read slot) and returns the bit read: the ROM search needs single bits. */
static int32_t esp_ow_bit(wasm_exec_env_t env, int32_t pin, int32_t bit) {
  if (!valid_pin(pin)) return -1;
  ow_setup(pin);
  return ow_bit(pin, bit != 0);
}

static void esp_ow_write(wasm_exec_env_t env, int32_t pin, int32_t byte) {
  if (!valid_pin(pin)) return;
  ow_setup(pin);
  for (int i = 0; i < 8; i++) ow_bit(pin, (byte >> i) & 1);
}

static int32_t esp_ow_read(wasm_exec_env_t env, int32_t pin) {
  if (!valid_pin(pin)) return -1;
  ow_setup(pin);
  int value = 0;
  for (int i = 0; i < 8; i++) value |= ow_bit(pin, 1) << i;
  return value;
}

// ---- HMAC-SHA256 (signing LoRa packets between nodes and a gateway) -------------------------

static int32_t esp_hmac(wasm_exec_env_t env, const uint8_t *key, uint32_t key_len, const uint8_t *data, uint32_t len, uint8_t *out, uint32_t cap) {
  if (cap < 32) return -1;
  const mbedtls_md_info_t *md = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  return mbedtls_md_hmac(md, key, key_len, data, len, out) == 0 ? 32 : -2;
}

// ---- events, messages, storage (the "lab" framework's host side) ---------------------------
//
// One queue feeds the program's event loop: GPIO edges (from interrupts), frames from the cloud
// or the console (ESPLAB RX <json>) and network changes. waitEvent() blocks in short slices so a
// reload can still stop the program.

enum { EV_TIMEOUT = 0, EV_GPIO = 1, EV_MESSAGE = 2, EV_NET = 3 };

typedef struct {
  uint8_t kind;
  uint16_t len;
  char *data;     // malloc'd payload (messages), or NULL
  uint8_t a, b;   // GPIO: pin, level. NET: wifi, cloud.
} vm_event_t;

static QueueHandle_t event_queue;

static void post_event(uint8_t kind, const char *data, size_t len, uint8_t a, uint8_t b) {
  if (!event_queue) return;
  vm_event_t ev = {.kind = kind, .len = 0, .data = NULL, .a = a, .b = b};
  if (data && len) {
    if (len > 4000) return;
    ev.data = malloc(len);
    if (!ev.data) return;
    memcpy(ev.data, data, len);
    ev.len = len;
  }
  if (xQueueSend(event_queue, &ev, 0) != pdTRUE) free(ev.data);
}

static void IRAM_ATTR gpio_isr(void *arg) {
  uint32_t pin = (uint32_t)arg;
  vm_event_t ev = {.kind = EV_GPIO, .a = (uint8_t)pin, .b = (uint8_t)gpio_get_level(pin)};
  BaseType_t woken = pdFALSE;
  xQueueSendFromISR(event_queue, &ev, &woken);
  if (woken) portYIELD_FROM_ISR();
}

static void drain_events(void) {
  vm_event_t ev;
  while (event_queue && xQueueReceive(event_queue, &ev, 0) == pdTRUE) free(ev.data);
}

/**
 * Waits up to timeoutMs for an event. Returns -1 when the program must stop (reload), 0 on
 * timeout, else (kind << 24) | payload length; the payload is copied to buf. GPIO payload:
 * [pin, level]. NET payload: [wifi, cloud]. MESSAGE payload: UTF-8 JSON.
 */
static int32_t esp_wait_event(wasm_exec_env_t env, int32_t timeout_ms, uint8_t *buf, uint32_t cap) {
  int64_t deadline = esp_timer_get_time() + (int64_t)(timeout_ms < 0 ? 0 : timeout_ms) * 1000;
  for (;;) {
    if (reload_requested) return -1;
    int64_t left_ms = (deadline - esp_timer_get_time()) / 1000;
    TickType_t slice = pdMS_TO_TICKS(left_ms > 50 ? 50 : left_ms > 0 ? left_ms : 0);
    vm_event_t ev;
    if (xQueueReceive(event_queue, &ev, slice) == pdTRUE) {
      uint32_t len = 0;
      if (ev.kind == EV_GPIO || ev.kind == EV_NET) {
        if (cap >= 2) { buf[0] = ev.a; buf[1] = ev.b; len = 2; }
        // NET: a third byte with the clock quality (programs before runtime 0.12 read two).
        if (ev.kind == EV_NET && cap >= 3) { buf[2] = (uint8_t)clock_quality(); len = 3; }
      } else if (ev.data) {
        len = ev.len <= cap ? ev.len : 0;  // oversized frames are dropped
        if (len) memcpy(buf, ev.data, len);
        free(ev.data);
        if (!len) continue;
      }
      return ((int32_t)ev.kind << 24) | (int32_t)len;
    }
    if (left_ms <= 0) return 0;
  }
}

/** Edge interrupts on an input pin: mode 1 rising, 2 falling, 3 both (0 detaches). */
static void esp_attach_interrupt(wasm_exec_env_t env, int32_t pin, int32_t mode) {
  static bool service;
  if (!valid_pin(pin)) return;
  if (!service) {
    gpio_install_isr_service(0);
    service = true;
  }
  gpio_isr_handler_remove((gpio_num_t)pin);
  if (mode <= 0) {
    gpio_set_intr_type((gpio_num_t)pin, GPIO_INTR_DISABLE);
    return;
  }
  gpio_set_intr_type((gpio_num_t)pin, mode == 1 ? GPIO_INTR_POSEDGE : mode == 2 ? GPIO_INTR_NEGEDGE : GPIO_INTR_ANYEDGE);
  gpio_isr_handler_add((gpio_num_t)pin, gpio_isr, (void *)(uint32_t)pin);
  gpio_intr_enable((gpio_num_t)pin);
}

/** UTF-16 (AssemblyScript strings) to UTF-8. Returns a malloc'd, NUL-terminated buffer. */
static char *utf16_to_utf8(const uint8_t *buf, uint32_t bytes, size_t *out_len) {
  char *out = malloc(bytes / 2 * 3 + 1);
  if (!out) return NULL;
  size_t n = 0;
  for (uint32_t i = 0; i + 2 <= bytes; i += 2) {
    uint16_t c = buf[i] | (buf[i + 1] << 8);
    if (c < 0x80) {
      out[n++] = (char)c;
    } else if (c < 0x800) {
      out[n++] = 0xC0 | (c >> 6);
      out[n++] = 0x80 | (c & 0x3F);
    } else {
      out[n++] = 0xE0 | (c >> 12);
      out[n++] = 0x80 | ((c >> 6) & 0x3F);
      out[n++] = 0x80 | (c & 0x3F);
    }
  }
  out[n] = 0;
  if (out_len) *out_len = n;
  return out;
}

/**
 * Sends one elp/1 frame (JSON). Over the cloud link when it is up; otherwise as a console line
 * "ESPLAB TX <json>", which ESP Lab relays when the device runs in the emulator or on USB.
 */
static void send_frame(const char *text, size_t len) {
  local_on_frame(text, len);
  if (!net_cloud_send(text, len)) printf("ESPLAB TX %s\n", text);
}

void labhost_send_frame(const char *text, size_t len) { send_frame(text, len); }

// A frame longer than the program's buffer arrives in pieces: the first UTF-16 unit is 1 ("more
// follows") or 2 ("last piece"). They are joined here and sent as one frame (at most 32 KiB).
static char *partial_frame;
static size_t partial_len;

static void drop_partial(void) {
  free(partial_frame);
  partial_frame = NULL;
  partial_len = 0;
}

static void esp_send(wasm_exec_env_t env, const uint8_t *buf, uint32_t bytes) {
  uint16_t marker = bytes >= 2 ? (uint16_t)(buf[0] | (buf[1] << 8)) : 0;
  if (marker == 1 || marker == 2) {
    size_t len = 0;
    char *piece = utf16_to_utf8(buf + 2, bytes - 2, &len);
    if (!piece) { drop_partial(); return; }
    char *joined = partial_len + len <= 32768 ? realloc(partial_frame, partial_len + len + 1) : NULL;
    if (!joined) {
      printf("[vm] frame too large or no memory, dropped\n");
      free(piece);
      drop_partial();
      return;
    }
    memcpy(joined + partial_len, piece, len);
    partial_frame = joined;
    partial_len += len;
    partial_frame[partial_len] = 0;
    free(piece);
    if (marker == 2) {
      send_frame(partial_frame, partial_len);
      drop_partial();
    }
    return;
  }
  if (partial_frame) drop_partial();  // an unfinished frame was abandoned
  size_t len = 0;
  char *text = utf16_to_utf8(buf, bytes, &len);
  if (!text) return;
  send_frame(text, len);
  free(text);
}

static bool kv_key(const uint8_t *buf, uint32_t bytes, char key[16]) {
  size_t len = 0;
  char *k = utf16_to_utf8(buf, bytes, &len);
  if (!k || !len) { free(k); return false; }
  snprintf(key, 16, "%s", k);  // NVS keys are at most 15 characters
  free(k);
  return true;
}

/** Program storage (NVS namespace "app"). Returns the value's UTF-8 length, or -1. */
static int32_t esp_kv_get(wasm_exec_env_t env, const uint8_t *kbuf, uint32_t kbytes, uint8_t *out, uint32_t cap) {
  char key[16];
  nvs_handle_t h;
  if (!kv_key(kbuf, kbytes, key) || nvs_open("app", NVS_READONLY, &h) != ESP_OK) return -1;
  size_t len = cap;
  esp_err_t err = nvs_get_blob(h, key, out, &len);
  nvs_close(h);
  return err == ESP_OK ? (int32_t)len : -1;
}

static int32_t esp_kv_set(wasm_exec_env_t env, const uint8_t *kbuf, uint32_t kbytes, const uint8_t *vbuf, uint32_t vbytes) {
  char key[16];
  nvs_handle_t h;
  if (!kv_key(kbuf, kbytes, key) || nvs_open("app", NVS_READWRITE, &h) != ESP_OK) return -1;
  size_t len = 0;
  char *value = utf16_to_utf8(vbuf, vbytes, &len);
  esp_err_t err = value ? nvs_set_blob(h, key, value, len) : ESP_ERR_NO_MEM;
  if (err == ESP_OK) err = nvs_commit(h);
  nvs_close(h);
  free(value);
  return err == ESP_OK ? 0 : -1;
}

/** Wall-clock time in ms since 1970, or 0 when the clock was never set. */
static int64_t esp_epoch_ms(wasm_exec_env_t env) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return tv.tv_sec > 1600000000 ? (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000 : 0;
}

static void esp_set_epoch_ms(wasm_exec_env_t env, int64_t ms) {
  if (ms <= 0) return;
  struct timeval tv = {.tv_sec = ms / 1000, .tv_usec = (ms % 1000) * 1000};
  settimeofday(&tv, NULL);
  clock_synced();
}

/** The level an output goes to when the program stops or traps (-1: leave it). */
static int8_t failsafe_level[GPIO_NUM_MAX];

static void esp_output_failsafe(wasm_exec_env_t env, int32_t pin, int32_t level) {
  if (valid_pin(pin)) failsafe_level[pin] = level < 0 ? -1 : level ? 1 : 0;
}

/**
 * Outputs on I2C expanders (KinCony relays on PCF8574s): the port value written to each expander
 * when the program stops, so a crash cannot leave a pump or heater relay on. Bit 16 of the value
 * marks a 16-bit PCF8575: both ports are written (P07..P00, then P17..P10). Runtimes before 0.11
 * kept one byte, so on those only the first port of a PCF8575 goes to its failsafe state.
 */
#define I2C_FAILSAFES 8
static struct { int16_t address; uint8_t value[2]; uint8_t length; } i2c_failsafe[I2C_FAILSAFES];

static i2c_master_dev_handle_t i2c_device(int32_t addr);

static void esp_i2c_failsafe(wasm_exec_env_t env, int32_t address, int32_t value) {
  if (address < 0 || address > 127) return;
  int free_slot = -1;
  for (int i = 0; i < I2C_FAILSAFES; i++) {
    if (i2c_failsafe[i].address == address) { free_slot = i; break; }
    if (i2c_failsafe[i].address < 0 && free_slot < 0) free_slot = i;
  }
  if (free_slot < 0) return;
  i2c_failsafe[free_slot].address = address;
  i2c_failsafe[free_slot].value[0] = value & 0xff;
  i2c_failsafe[free_slot].value[1] = (value >> 8) & 0xff;
  i2c_failsafe[free_slot].length = (value & 0x10000) ? 2 : 1;
}

static void apply_failsafe(void) {
  for (int pin = 0; pin < GPIO_NUM_MAX; pin++) {
    if (failsafe_level[pin] >= 0) gpio_set_level((gpio_num_t)pin, failsafe_level[pin]);
    failsafe_level[pin] = -1;
  }
  for (int i = 0; i < I2C_FAILSAFES; i++) {
    if (i2c_failsafe[i].address < 0) continue;
    i2c_master_dev_handle_t dev = i2c_device(i2c_failsafe[i].address);
    if (dev) i2c_master_transmit(dev, i2c_failsafe[i].value, i2c_failsafe[i].length, 50);
    i2c_failsafe[i].address = -1;
  }
}

/** The device id: "esp32-" + the factory MAC, as ASCII. */
static int32_t esp_device_id(wasm_exec_env_t env, uint8_t *out, uint32_t cap) {
  uint8_t mac[6] = {0};
  esp_efuse_mac_get_default(mac);
  char id[24];
  int n = snprintf(id, sizeof(id), "esp32-%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  if ((uint32_t)n > cap) return -1;
  memcpy(out, id, n);
  return n;
}

static NativeSymbol esp_symbols[] = {
  {"waitEvent", esp_wait_event, "(i*~)i", NULL},
  {"attachInterrupt", esp_attach_interrupt, "(ii)", NULL},
  {"send", esp_send, "(*~)", NULL},
  {"kvGet", esp_kv_get, "(*~*~)i", NULL},
  {"kvSet", esp_kv_set, "(*~*~)i", NULL},
  {"epochMs", esp_epoch_ms, "()I", NULL},
  {"setEpochMs", esp_set_epoch_ms, "(I)", NULL},
  {"outputFailsafe", esp_output_failsafe, "(ii)", NULL},
  {"deviceId", esp_device_id, "(*~)i", NULL},
  {"pinMode", esp_pin_mode, "(ii)", NULL},
  {"digitalWrite", esp_digital_write, "(ii)", NULL},
  {"digitalRead", esp_digital_read, "(i)i", NULL},
  {"analogRead", esp_analog_read, "(i)i", NULL},
  {"analogWrite", esp_analog_write, "(ii)", NULL},
  {"delay", esp_delay, "(i)", NULL},
  {"delayMicroseconds", esp_delay_us, "(i)", NULL},
  {"millis", esp_millis, "()I", NULL},
  {"micros", esp_micros, "()I", NULL},
  {"random", esp_random_i, "(i)i", NULL},
  {"print", esp_print, "(*~)", NULL},
  {"i2cBegin", esp_i2c_begin, "(iii)i", NULL},
  {"i2cWrite", esp_i2c_write, "(i*~)i", NULL},
  {"i2cRead", esp_i2c_read, "(i*~)i", NULL},
  {"uartOpen", esp_uart_open, "(iiiiii)i", NULL},
  {"uartWrite", esp_uart_write, "(i*~)i", NULL},
  {"uartRead", esp_uart_read, "(i*~i)i", NULL},
  {"uartAvailable", esp_uart_available, "(i)i", NULL},
  {"spiBegin", esp_spi_begin, "(iii)i", NULL},
  {"spiDevice", esp_spi_device, "(iii)i", NULL},
  {"spiTransfer", esp_spi_transfer, "(i*~)i", NULL},
  {"owReset", esp_ow_reset, "(i)i", NULL},
  {"owBit", esp_ow_bit, "(ii)i", NULL},
  {"owWrite", esp_ow_write, "(ii)", NULL},
  {"owRead", esp_ow_read, "(i)i", NULL},
  {"hmacSha256", esp_hmac, "(*~*~*~)i", NULL},
  {"i2cFailsafe", esp_i2c_failsafe, "(ii)", NULL},
};

// AssemblyScript's abort(message, file, line, column). Message/file are UTF-16 string pointers
// whose byte length sits 4 bytes before the data.
static void print_as_string(wasm_module_inst_t inst, int32_t ptr) {
  if (!ptr || !wasm_runtime_validate_app_addr(inst, ptr - 4, 4)) return;
  uint32_t *len = wasm_runtime_addr_app_to_native(inst, ptr - 4);
  if (!wasm_runtime_validate_app_addr(inst, ptr, *len)) return;
  esp_print(NULL, wasm_runtime_addr_app_to_native(inst, ptr), *len);
}

static void env_abort(wasm_exec_env_t env, int32_t msg, int32_t file, int32_t line, int32_t col) {
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  printf("[vm] abort: ");
  print_as_string(inst, msg);
  printf(" (");
  print_as_string(inst, file);
  printf(":%ld:%ld)\n", (long)line, (long)col);
  wasm_runtime_set_exception(inst, "abort");
}

static void env_seed_none(wasm_exec_env_t env) {}

static double env_seed(wasm_exec_env_t env) { return (double)esp_random(); }

static NativeSymbol env_symbols[] = {
  {"abort", env_abort, "(iiii)", NULL},
  {"seed", env_seed, "()F", NULL},
  {"trace", env_seed_none, "(iiddddd)", NULL},
};

// ---- VM loop ------------------------------------------------------------------------------

static bool call(wasm_module_inst_t inst, wasm_exec_env_t exec, wasm_function_inst_t fn, const char *name) {
  if (!fn) return true;
  if (wasm_runtime_call_wasm(exec, fn, 0, NULL)) return true;
  const char *ex = wasm_runtime_get_exception(inst);
  if (reload_requested) return false;  // stopped on purpose for a new program
  printf("[vm] trap in %s(): %s\n", name, ex ? ex : "unknown");
  return false;
}

// ---- trial, confirmation and rollback of deployed programs ---------------------------------------

static volatile bool rollback_now;    // vm_thread: start the restored program right away
static volatile uint32_t run_generation;
static esp_timer_handle_t trial_timer;

/** Reports a deployment's progress to the hub (or keeps it until the cloud link is up). */
static void deploy_report(const char *id, const char *state, const char *detail) {
  if (!id || !id[0]) return;
  char frame[sizeof(pending_report)];
  snprintf(frame, sizeof(frame), "{\"t\":\"deploy\",\"id\":\"%s\",\"state\":\"%s\",\"detail\":\"%s\"}", id, state, detail ? detail : "");
  printf("[ota] program %s: %s%s%s\n", id, state, detail && detail[0] ? " - " : "", detail ? detail : "");
  if (!net_cloud_send(frame, strlen(frame))) snprintf(pending_report, sizeof(pending_report), "%s", frame);
}

static void rollback(const char *reason) {
  char id[sizeof(trial_deploy)];
  snprintf(id, sizeof(id), "%s", trial_deploy);
  active_slot ^= 1;
  trial = false;
  trial_deploy[0] = 0;
  slots_save();
  printf("[ota] the new program failed (%s): back to the previous one\n", reason);
  deploy_report(id, "rolledback", reason);
}

static void trial_timer_fired(void *arg) {
  if ((uint32_t)(uintptr_t)arg != run_generation || !running_inst || !trial) return;
  char id[sizeof(trial_deploy)];
  snprintf(id, sizeof(id), "%s", trial_deploy);
  trial = false;
  trial_deploy[0] = 0;
  slots_save();
  deploy_report(id, "confirmed", "ran 30 s without a fault");
}

static void start_trial_timer(uint32_t generation) {
  if (trial_timer) {
    esp_timer_stop(trial_timer);
    esp_timer_delete(trial_timer);
    trial_timer = NULL;
  }
  esp_timer_create_args_t args = {.callback = trial_timer_fired, .arg = (void *)(uintptr_t)generation, .name = "trial"};
  if (esp_timer_create(&args, &trial_timer) == ESP_OK) esp_timer_start_once(trial_timer, (uint64_t)TRIAL_MS * 1000);
}

static void run_program(void) {
  char error[128];
  uint32_t len = 0;
  uint8_t *code = load_program(&len);
  if (!code) return;

  size_t heap0 = esp_get_free_heap_size();
  wasm_module_t module = wasm_runtime_load(code, len, error, sizeof(error));
  size_t heap1 = esp_get_free_heap_size();
  if (!module) {
    printf("[vm] invalid program: %s\n", error);
    free(code);
    if (trial) {
      rollback("invalid program");
      rollback_now = true;
    }
    return;
  }
  wasm_module_inst_t inst = wasm_runtime_instantiate(module, VM_STACK_SIZE, VM_HEAP_SIZE, error, sizeof(error));
  if (!inst) {
    printf("[vm] program could not start: %s\n", error);
    apply_failsafe();
    wasm_runtime_unload(module);
    free(code);
    if (trial) {
      rollback(error);
      rollback_now = true;
    }
    return;
  }
  size_t heap2 = esp_get_free_heap_size();
  wasm_exec_env_t exec = wasm_runtime_create_exec_env(inst, VM_STACK_SIZE);
  printf("[vm] memory: code %lu, load %lu, instantiate %lu, exec %lu bytes\n", (unsigned long)len,
         (unsigned long)(heap0 - heap1), (unsigned long)(heap1 - heap2), (unsigned long)(heap2 - esp_get_free_heap_size()));
  // "lab" programs export __lab_run (their event loop); classic ones setup() and loop().
  wasm_function_inst_t run = wasm_runtime_lookup_function(inst, "__lab_run");
  wasm_function_inst_t setup = wasm_runtime_lookup_function(inst, "setup");
  wasm_function_inst_t loop = wasm_runtime_lookup_function(inst, "loop");
  if (!run && !setup && !loop) printf("[vm] the program exports neither setup() nor loop()\n");

  printf("[vm] ready (%lu byte program, %s program memory, %lu free heap)\n", (unsigned long)len,
         arena_size >= 2 * 65536 ? "128 KiB" : "64 KiB", (unsigned long)esp_get_free_heap_size());
  drain_events();
  running_inst = inst;
  uint32_t generation = ++run_generation;
  if (trial) start_trial_timer(generation);
  if (run) {
    call(inst, exec, run, "event loop");
  } else if (call(inst, exec, setup, "setup")) {
    while (loop && !reload_requested && call(inst, exec, loop, "loop")) {
      vTaskDelay(1);  // let IDLE run so the task watchdog stays fed
    }
  }
  running_inst = NULL;
  apply_failsafe();
  if (!reload_requested && trial) {
    const char *ex = wasm_runtime_get_exception(inst);
    rollback(ex ? ex : "the program stopped");
    rollback_now = true;
  }

  wasm_runtime_destroy_exec_env(exec);
  wasm_runtime_deinstantiate(inst);
  wasm_runtime_unload(module);
  free(code);
}

// ---- program memory ------------------------------------------------------------------------
//
// A wasm program's memory must be one contiguous block in 64 KiB pages. Once Wi-Fi and TLS are
// up the largest free block is ~110 KiB, so a second page could never be found later. The
// arena is reserved at boot, before anything fragments the heap, and every program's linear
// memory lives in it (growing from one page to two in place). Other WAMR allocations use the heap.

// RAM budget of a classic ESP32 without PSRAM (~270 KiB free at boot): a 40 KiB program costs
// ~86 KiB (code copy, loaded module, stacks), Wi-Fi ~65 KiB and the TLS cloud link ~26 KiB. So a
// device that goes online gets one page (64 KiB) and an offline device two (128 KiB).
static void reserve_arena(void) {
  char ssid[33];
#if CONFIG_SPIRAM
  // Boards with PSRAM (ESP32-S3 N8R8, WROVER): two pages whatever the network needs.
  if (esp_psram_is_initialized()) {
    arena_size = 2 * 65536;
    arena = heap_caps_aligned_alloc(8, arena_size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (arena) return;
  }
#endif
  // Loading a program costs about twice its size in RAM besides its memory: a big program
  // (over 44 KiB) gets one page even offline, so the firmware keeps enough heap.
  uint32_t program_len = 0, program_crc = 0;
  const esp_partition_t *store = program_partition();
  bool big = store && slot_header(store, active_slot, &program_len, &program_crc) && program_len > 45056;
  arena_size = (net_config_get("ssid", ssid, sizeof(ssid)) || big) ? 65536 : 2 * 65536;
  arena = heap_caps_aligned_alloc(8, arena_size, MALLOC_CAP_8BIT);
  if (!arena && arena_size > 65536) {
    arena_size = 65536;
    arena = heap_caps_aligned_alloc(8, arena_size, MALLOC_CAP_8BIT);
  }
  if (!arena) {
    arena_size = 0;
    printf("[vm] could not reserve program memory at boot\n");
  }
}

static void *vm_malloc(mem_alloc_usage_t usage, unsigned int size) {
  if (usage == Alloc_For_LinearMemory && arena && !arena_used && size <= arena_size) {
    arena_used = true;
    memset(arena, 0, arena_size);
    return arena;
  }
  void *p = heap_caps_malloc(size, MALLOC_CAP_8BIT);
  if (p && usage == Alloc_For_LinearMemory) memset(p, 0, size);
  return p;
}

static void *vm_realloc(mem_alloc_usage_t usage, bool full_size_mmaped, void *ptr, unsigned int size) {
  if (ptr && ptr == arena) return size <= arena_size ? arena : NULL;  // grows in place, already zeroed
  return heap_caps_realloc(ptr, size, MALLOC_CAP_8BIT);
}

static void vm_free(mem_alloc_usage_t usage, void *ptr) {
  if (ptr && ptr == arena) {
    arena_used = false;
    return;
  }
  free(ptr);
}

static void *vm_thread(void *arg) {
  RuntimeInitArgs init;
  memset(&init, 0, sizeof(init));
  init.mem_alloc_type = Alloc_With_Allocator;
  init.mem_alloc_option.allocator.malloc_func = (void *)vm_malloc;
  init.mem_alloc_option.allocator.realloc_func = (void *)vm_realloc;
  init.mem_alloc_option.allocator.free_func = (void *)vm_free;
  if (!wasm_runtime_full_init(&init)) {
    printf("[vm] runtime init failed\n");
    return NULL;
  }
  wasm_runtime_register_natives("esp", esp_symbols, sizeof(esp_symbols) / sizeof(esp_symbols[0]));
  wasm_runtime_register_natives("env", env_symbols, sizeof(env_symbols) / sizeof(env_symbols[0]));
  labhost_register();

  for (;;) {
    reload_requested = false;
    run_program();
    if (rollback_now) {
      rollback_now = false;
      printf("[vm] starting the previous program\n");
      continue;
    }
    if (!reload_requested) printf("[vm] stopped. Waiting for a new program.\n");
    // Whether the program ended or was stopped for a reload, wait until the loader says go:
    // a new program must be fully written before it is read back.
    vm_idle = true;
    xSemaphoreTake(reload_signal, portMAX_DELAY);
    vm_idle = false;
    printf("[vm] starting the new program\n");
  }
  return NULL;
}

// ---- console loader -----------------------------------------------------------------------

/** Stops the running program and waits (up to 2 s) until the VM is idle. */
static bool stop_program(void) {
  reload_requested = true;
  for (int i = 0; i < 200 && !vm_idle; i++) {
    wasm_module_inst_t inst = running_inst;
    if (inst) wasm_runtime_terminate(inst);
    vTaskDelay(pdMS_TO_TICKS(10));
  }
  return vm_idle;
}

static void start_program(void) { xSemaphoreGive(reload_signal); }

static void handle_load(uint32_t len, uint32_t crc) {
  const esp_partition_t *part = program_partition();
  if (!part || len == 0 || len > part->size - BLOB_HEADER) {
    printf("ESPLAB ERR size\n");
    return;
  }
  uint8_t *wasm = malloc(len);
  if (!wasm) {
    printf("ESPLAB ERR memory\n");
    return;
  }
  uint32_t got = 0;
  char line[256];
  size_t n = 0;
  int64_t deadline = esp_timer_get_time() + 20 * 1000000LL;
  while (got < len && esp_timer_get_time() < deadline) {
    uint8_t c;
    if (!console_read(&c, pdMS_TO_TICKS(100))) continue;
    if (c == '\r') continue;
    if (c != '\n') {
      if (n < sizeof(line) - 1) line[n++] = (char)c;
      continue;
    }
    size_t out = 0;
    if (mbedtls_base64_decode(wasm + got, len - got, &out, (const unsigned char *)line, n) != 0) {
      printf("ESPLAB ERR base64\n");
      free(wasm);
      return;
    }
    got += out;
    n = 0;
  }
  if (got != len) {
    printf("ESPLAB ERR timeout %lu/%lu\n", (unsigned long)got, (unsigned long)len);
  } else if (crc32_ieee(wasm, len) != crc) {
    printf("ESPLAB ERR crc\n");
  } else {
    // Order matters: stop the old program, write the new one, then start it.
    if (!stop_program()) {
      printf("ESPLAB ERR busy\n");
    } else if (store_program(wasm, len, crc)) {
      printf("ESPLAB OK %lu\n", (unsigned long)len);
    } else {
      printf("ESPLAB ERR flash\n");
    }
    start_program();
  }
  free(wasm);
}

// ---- over-the-air program deployment --------------------------------------------------------------
//
// Hub: {"t":"deploy","id","ver","size","crc"}  ->  device pulls {"t":"chunkreq","id","off","len"}
// Hub: {"t":"chunk","id","off","d":"<base64>"}   ->  written to the free slot; at the end the CRC is
// checked, the slot becomes active on trial and the VM restarts with it.
#define CHUNK 1024

static struct {
  bool active;
  char id[48];
  uint32_t size, crc, off;
  uint8_t slot;
} dl;

static void request_chunk(void) {
  char frame[128];
  uint32_t n = dl.size - dl.off < CHUNK ? dl.size - dl.off : CHUNK;
  int len = snprintf(frame, sizeof(frame), "{\"t\":\"chunkreq\",\"id\":\"%s\",\"off\":%lu,\"len\":%lu}", dl.id, (unsigned long)dl.off, (unsigned long)n);
  if (!net_cloud_send(frame, len)) dl.active = false;
}

static void deploy_finish(const esp_partition_t *part) {
  // Verify what is in flash, not what we meant to write.
  uint8_t buf[256];
  uint32_t crc = 0;
  for (uint32_t at = 0; at < dl.size; at += sizeof(buf)) {
    uint32_t n = dl.size - at < sizeof(buf) ? dl.size - at : sizeof(buf);
    if (esp_partition_read(part, slot_base(part, dl.slot) + BLOB_HEADER + at, buf, n) != ESP_OK) break;
    crc = esp_rom_crc32_le(crc, buf, n);
  }
  dl.active = false;
  if (crc != dl.crc) {
    deploy_report(dl.id, "failed", "checksum mismatch after download");
    return;
  }
  if (!write_slot_header(part, dl.slot, dl.size, dl.crc)) {
    deploy_report(dl.id, "failed", "flash write failed");
    return;
  }
  if (!stop_program()) {
    deploy_report(dl.id, "failed", "the running program did not stop");
    return;
  }
  active_slot = dl.slot;
  trial = true;
  snprintf(trial_deploy, sizeof(trial_deploy), "%s", dl.id);
  slots_save();
  deploy_report(dl.id, "installed", "running on trial for 30 s");
  start_program();
}

/** Handles deploy/chunk frames from the hub; returns true when the frame was one of them. */
static bool handle_deploy_frame(const char *text, size_t len) {
  if (len < 12 || (strncmp(text, "{\"t\":\"deploy\"", 13) != 0 && strncmp(text, "{\"t\":\"chunk\"", 12) != 0)) return false;
  cJSON *msg = cJSON_ParseWithLength(text, len);
  if (!msg) return true;
  const char *t = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "t"));
  const char *id = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "id"));
  const esp_partition_t *part = program_partition();
  if (t && id && part && strcmp(t, "deploy") == 0) {
    uint32_t size = (uint32_t)cJSON_GetNumberValue(cJSON_GetObjectItem(msg, "size"));
    const char *crc_hex = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "crc"));
    memset(&dl, 0, sizeof(dl));
    snprintf(dl.id, sizeof(dl.id), "%s", id);
    if (!crc_hex || size == 0 || size > slot_size(part) - BLOB_HEADER) {
      deploy_report(id, "failed", "the program does not fit");
    } else {
      dl.size = size;
      dl.crc = (uint32_t)strtoul(crc_hex, NULL, 16);
      dl.slot = active_slot ^ 1;
      size_t span = (BLOB_HEADER + size + 4095) & ~4095u;
      if (esp_partition_erase_range(part, slot_base(part, dl.slot), span) != ESP_OK) {
        deploy_report(id, "failed", "flash erase failed");
      } else {
        dl.active = true;
        printf("[ota] receiving program %s (%lu bytes)\n", dl.id, (unsigned long)size);
        deploy_report(id, "downloading", "");
        request_chunk();
      }
    }
  } else if (t && id && part && strcmp(t, "chunk") == 0 && dl.active && strcmp(id, dl.id) == 0) {
    uint32_t off = (uint32_t)cJSON_GetNumberValue(cJSON_GetObjectItem(msg, "off"));
    const char *data = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "d"));
    uint8_t bytes[CHUNK];
    size_t n = 0;
    if (off != dl.off || !data || mbedtls_base64_decode(bytes, sizeof(bytes), &n, (const unsigned char *)data, strlen(data)) != 0 ||
        n == 0 || dl.off + n > dl.size ||
        esp_partition_write(part, slot_base(part, dl.slot) + BLOB_HEADER + dl.off, bytes, n) != ESP_OK) {
      dl.active = false;
      deploy_report(dl.id, "failed", "bad chunk");
    } else {
      dl.off += n;
      if (dl.off < dl.size) request_chunk();
      else deploy_finish(part);
    }
  }
  cJSON_Delete(msg);
  return true;
}

// ---- firmware updates (through ESP Lab Recovery in the factory slot) -------------------------------

static bool recovery_present(void) {
  const esp_partition_t *factory = esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_FACTORY, NULL);
  esp_app_desc_t desc;
  return factory && esp_ota_get_partition_description(factory, &desc) == ESP_OK && strcmp(desc.project_name, "esplab-recovery") == 0;
}

static void nvs_str(const char *key, const char *value) {
  nvs_handle_t h;
  if (nvs_open("esplab", NVS_READWRITE, &h) != ESP_OK) return;
  if (value) nvs_set_str(h, key, value);
  else nvs_erase_key(h, key);
  nvs_commit(h);
  nvs_close(h);
}

/** {"t":"fwupdate","id","url","sha","ver"}: hand over to Recovery, which installs the image. */
static bool handle_fwupdate_frame(const char *text, size_t len) {
  if (len < 16 || strncmp(text, "{\"t\":\"fwupdate\"", 15) != 0) return false;
  cJSON *msg = cJSON_ParseWithLength(text, len);
  if (!msg) return true;
  const char *id = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "id"));
  const char *url = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "url"));
  const char *sha = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "sha"));
  const char *ver = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "ver"));
  if (id && url && ver) {
    if (strcmp(ver, RUNTIME_VERSION) == 0) {
      deploy_report(id, "confirmed", "already running this version");
    } else if (!recovery_present()) {
      deploy_report(id, "failed", "this board has no ESP Lab Recovery: update it once over USB");
    } else if (strlen(url) > 190) {
      deploy_report(id, "failed", "firmware URL too long");
    } else {
      nvs_str("fwurl", url);
      nvs_str("fwsha", sha ? sha : "");
      nvs_str("fwid", id);
      nvs_str("fwver", ver);
      deploy_report(id, "downloading", "restarting into ESP Lab Recovery");
      const esp_partition_t *factory = esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_FACTORY, NULL);
      vTaskDelay(pdMS_TO_TICKS(500));  // let the report leave
      stop_program();
      esp_ota_set_boot_partition(factory);
      esp_restart();
    }
  }
  cJSON_Delete(msg);
  return true;
}

/** After Recovery installed an update: report whether the expected version is the one running. */
static void check_firmware_update(void) {
  char id[48], ver[24];
  nvs_handle_t h;
  if (nvs_open("esplab", NVS_READONLY, &h) != ESP_OK) return;
  size_t n = sizeof(id), m = sizeof(ver);
  bool pending = nvs_get_str(h, "fwid", id, &n) == ESP_OK && nvs_get_str(h, "fwver", ver, &m) == ESP_OK;
  nvs_close(h);
  if (!pending) return;
  if (strcmp(ver, RUNTIME_VERSION) == 0) deploy_report(id, "confirmed", "firmware " RUNTIME_VERSION " is running");
  else deploy_report(id, "failed", "the update did not take: still on " RUNTIME_VERSION);
  nvs_str("fwid", NULL);
  nvs_str("fwver", NULL);
}

// ---- setup mode -------------------------------------------------------------------------------

/**
 * Setup mode (own Wi-Fi network and setup page) when there is no Wi-Fi configured and: the
 * console asked for it, BOOT (GPIO 0) is held at power-up, or the board was just converted from
 * Tasmota (no ESP Lab program yet, Tasmota's file system still in the data partition).
 */
static bool setup_mode_wanted(void) {
  char value[33];
  if (net_config_get("ssid", value, sizeof(value))) return false;
  if (net_config_get("portal", value, sizeof(value))) return true;
  gpio_reset_pin(GPIO_NUM_0);
  gpio_set_direction(GPIO_NUM_0, GPIO_MODE_INPUT);
  gpio_set_pull_mode(GPIO_NUM_0, GPIO_PULLUP_ONLY);
  bool held = true;
  for (int i = 0; i < 10 && held; i++) {
    held = gpio_get_level(GPIO_NUM_0) == 0;
    vTaskDelay(pdMS_TO_TICKS(30));
  }
  if (held) return true;
  const esp_partition_t *part = program_partition();
  uint32_t len, crc;
  if (part && !slot_header(part, 0, &len, &crc) && !slot_header(part, 1, &len, &crc)) {
    uint8_t block[16];
    if (esp_partition_read(part, 0, block, sizeof(block)) == ESP_OK && memcmp(block + 8, "littlefs", 8) == 0) return true;
  }
  return false;
}

// ---- moving from Tasmota over Wi-Fi --------------------------------------------------------
//
// Before upgrading, a Berry script ESP Lab gives the user writes "ESPLABCFG1\n" and key=value
// lines (ssid, psk, claim, hub) into the last 4 KiB of the data partition (unused by programs).
// The first boot takes them over and erases them: the device joins the same Wi-Fi and claims
// itself into the project, without a visit.
static void import_handover(void) {
  const esp_partition_t *part = program_partition();
  if (!part || part->size < 0x2000) return;
  size_t at = part->size - 0x1000;
  char block[512];
  if (esp_partition_read(part, at, block, sizeof(block)) != ESP_OK || memcmp(block, "ESPLABCFG1\n", 11) != 0) return;
  block[sizeof(block) - 1] = 0;
  char *line = block + 11;
  int taken = 0;
  while (line && *line) {
    char *end = strchr(line, '\n');
    if (end) *end = 0;
    char *eq = strchr(line, '=');
    if (eq) {
      *eq = 0;
      const char *key = line;
      if (!strcmp(key, "ssid") || !strcmp(key, "psk") || !strcmp(key, "claim") || !strcmp(key, "hub")) {
        if (net_config_set(key, eq + 1)) taken++;
      }
    }
    line = end ? end + 1 : NULL;
  }
  esp_partition_erase_range(part, at, 0x1000);
  printf("[setup] %d settings handed over from Tasmota: joining the Wi-Fi and the ESP Lab project\n", taken);
}

// ---- cloud link hooks (net.c) ---------------------------------------------------------------

void net_on_cloud(bool up) {
  post_event(EV_NET, NULL, 0, net_wifi_ready(), up);
  if (up) {
    char info[200];
    int n = snprintf(info, sizeof(info), "{\"t\":\"info\",\"fw\":\"" RUNTIME_VERSION "\",\"target\":\"" CONFIG_IDF_TARGET "\",\"recovery\":%s,\"slot\":%d,\"chip\":\"%s\",\"ip\":\"%s\"}",
                     recovery_present() ? "true" : "false", active_slot, chip_id(), net_ip());
    net_cloud_send(info, n);
  }
  if (up && pending_report[0]) {
    if (net_cloud_send(pending_report, strlen(pending_report))) pending_report[0] = 0;
  }
}

const char *net_runtime_version(void) { return RUNTIME_VERSION; }

// ---- local page and clock hooks (local.c, clock.c) ------------------------------------------

void local_deliver(const char *text, size_t len) { post_event(EV_MESSAGE, text, len, 0, 0); }

void clock_changed(void) { post_event(EV_NET, NULL, 0, net_wifi_ready(), net_cloud_ready()); }

void net_on_message(const char *text, size_t len) {
  if (handle_deploy_frame(text, len) || handle_fwupdate_frame(text, len)) return;
  post_event(EV_MESSAGE, text, len, 0, 0);
}

/** "esp32-" + factory MAC: the id the device registers with on the hub. */
static const char *chip_id(void) {
  static char id[24];
  if (!id[0]) {
    uint8_t mac[6] = {0};
    esp_efuse_mac_get_default(mac);
    snprintf(id, sizeof(id), "esp32-%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  }
  return id;
}

static void print_info(void) {
  const esp_partition_t *app = esp_ota_get_running_partition();
  const esp_partition_t *prog = program_partition();
  printf("ESPLAB INFO id=%s fw=" RUNTIME_VERSION " app=%s@0x%lx data=%s@0x%lx+0x%lx wifi=%d cloud=%d\n", chip_id(),
         app ? app->label : "?", app ? (unsigned long)app->address : 0,
         prog ? prog->label : "none", prog ? (unsigned long)prog->address : 0, prog ? (unsigned long)prog->size : 0,
         net_wifi_ready(), net_cloud_ready());
  net_heap_report("info");
}

static void console_task(void *arg) {
  static char line[2048];
  size_t n = 0;
  for (;;) {
    uint8_t c;
    if (!console_read(&c, portMAX_DELAY)) continue;
    if (c == '\r') continue;
    if (c != '\n') {
      if (n < sizeof(line) - 1) line[n++] = (char)c;
      continue;
    }
    line[n] = 0;
    n = 0;
    unsigned long len = 0, crc = 0;
    if (sscanf(line, "ESPLAB LOAD %lu %lx", &len, &crc) == 2) {
      handle_load(len, crc);
    } else if (strcmp(line, "ESPLAB PING") == 0) {
      printf("ESPLAB PONG " RUNTIME_VERSION " %s\n", chip_id());
    } else if (strcmp(line, "ESPLAB RESTART") == 0) {
      stop_program();
      start_program();
    } else if (strncmp(line, "ESPLAB RX ", 10) == 0) {
      post_event(EV_MESSAGE, line + 10, strlen(line + 10), 0, 0);
    } else if (strncmp(line, "ESPLAB SET ", 11) == 0) {
      char *eq = strchr(line + 11, '=');
      if (eq) *eq = 0;
      printf(eq && net_config_set(line + 11, eq + 1) ? "ESPLAB OK set\n" : "ESPLAB ERR set\n");
    } else if (strcmp(line, "ESPLAB SETUP") == 0) {
      char ssid[33];
      if (arena_size > 65536 && net_config_get("ssid", ssid, sizeof(ssid))) {
        // Going online needs the RAM an offline device gives its program: restart with one page.
        printf("ESPLAB OK setup (restarting to go online)\n");
        fflush(stdout);
        vTaskDelay(pdMS_TO_TICKS(100));
        esp_restart();
      }
      printf("ESPLAB OK setup\n");
      net_start();
    } else if (strcmp(line, "ESPLAB PORTAL") == 0) {
      // Forget the Wi-Fi and open the setup page (own Wi-Fi network) after a restart.
      net_config_set("ssid", "");
      net_config_set("token", "");
      net_config_set("portal", "1");
      printf("ESPLAB OK portal (restarting into setup mode)\n");
      fflush(stdout);
      vTaskDelay(pdMS_TO_TICKS(100));
      esp_restart();
    } else if (strcmp(line, "ESPLAB INFO") == 0) {
      print_info();
    }
  }
}

void app_main(void) {
  printf("\nESP Lab Runtime " RUNTIME_VERSION " (WAMR)\n");
  reload_signal = xSemaphoreCreateBinary();
  event_queue = xQueueCreate(24, sizeof(vm_event_t));
  memset(failsafe_level, -1, sizeof(failsafe_level));
  for (int i = 0; i < I2C_FAILSAFES; i++) i2c_failsafe[i].address = -1;
  net_init();
  clock_init();
  import_handover();
  slots_load();
  if (trial) rollback("the board restarted before the new program was confirmed");
  check_firmware_update();
  esp_ota_mark_app_valid_cancel_rollback();  // booted: this firmware is good
  if (setup_mode_wanted()) {
    // The console stays up (USB setup still works); no program runs in setup mode.
    console_start();
    xTaskCreatePinnedToCore(console_task, "console", 6 * 1024, NULL, 6, NULL, 0);
    portal_start();
    return;
  }
  reserve_arena();  // before Wi-Fi and the VM: the heap is still in one piece
  print_info();

  // The console UART doubles as the program loader. It runs on core 0, so a program stuck in a
  // busy loop on core 1 can still be replaced.
  console_start();
  xTaskCreatePinnedToCore(console_task, "console", 6 * 1024, NULL, 6, NULL, 0);

  // WAMR's ESP-IDF port relies on pthread APIs, so the VM runs on a pthread, not a bare task.
  // Core 1: its IDLE task is not watched by the task watchdog, so a busy loop does not reset the chip.
  esp_pthread_cfg_t cfg = esp_pthread_get_default_config();
  cfg.pin_to_core = portNUM_PROCESSORS > 1 ? 1 : 0;  // the ESP32-C3 has one core
  cfg.thread_name = "vm";
  esp_pthread_set_cfg(&cfg);
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setstacksize(&attr, 16 * 1024);
  pthread_t thread;
  if (pthread_create(&thread, &attr, vm_thread, NULL) != 0) printf("[vm] could not start the VM thread\n");
  pthread_attr_destroy(&attr);

  net_start();
}
