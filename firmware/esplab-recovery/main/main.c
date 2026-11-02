// ESP Lab Recovery: a small app in the factory slot that installs ESP Lab Runtime firmware.
//
// The runtime cannot overwrite the slot it runs from, so for a firmware update it stores the
// image URL and SHA-256 in NVS ("esplab": fwurl, fwsha) and restarts here. Recovery joins the
// configured Wi-Fi, downloads the image into app0, checks its SHA-256 and boots it. If anything
// fails it retries; it never leaves the board without a way to update. With nothing to do it
// boots app0 (also how a board whose app0 is fine gets back from a stray restart into factory).
#include <stdio.h>
#include <string.h>

#include "esp_event.h"
#include "esp_https_ota.h"
#include "esp_crt_bundle.h"
#include "esp_netif.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "nvs.h"
#include "nvs_flash.h"

#define RECOVERY_VERSION "0.1"
static EventGroupHandle_t events;
#define GOT_IP BIT0

static bool cfg(const char *key, char *out, size_t size) {
  nvs_handle_t h;
  out[0] = 0;
  if (nvs_open("esplab", NVS_READONLY, &h) != ESP_OK) return false;
  size_t len = size;
  esp_err_t err = nvs_get_str(h, key, out, &len);
  nvs_close(h);
  return err == ESP_OK && out[0];
}

static void set_cfg(const char *key, const char *value) {
  nvs_handle_t h;
  if (nvs_open("esplab", NVS_READWRITE, &h) != ESP_OK) return;
  if (value) nvs_set_str(h, key, value);
  else nvs_erase_key(h, key);
  nvs_commit(h);
  nvs_close(h);
}

static void boot_app0(const char *why) {
  const esp_partition_t *app0 = esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_0, NULL);
  esp_app_desc_t desc;
  if (app0 && esp_ota_get_partition_description(app0, &desc) == ESP_OK) {
    printf("[recovery] %s: booting %s %s\n", why, desc.project_name, desc.version);
    esp_ota_set_boot_partition(app0);
    esp_restart();
  }
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
  if (base == WIFI_EVENT && (id == WIFI_EVENT_STA_START || id == WIFI_EVENT_STA_DISCONNECTED)) esp_wifi_connect();
  if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) xEventGroupSetBits(events, GOT_IP);
}

static bool join_wifi(void) {
  char ssid[33], psk[65];
  if (!cfg("ssid", ssid, sizeof(ssid))) return false;
  cfg("psk", psk, sizeof(psk));
  events = xEventGroupCreate();
  esp_netif_init();
  esp_event_loop_create_default();
  esp_netif_create_default_wifi_sta();
  wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
  esp_wifi_init(&init);
  esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL);
  esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL);
  esp_wifi_set_storage(WIFI_STORAGE_RAM);
  esp_wifi_set_mode(WIFI_MODE_STA);
  wifi_config_t wc = {0};
  strncpy((char *)wc.sta.ssid, ssid, sizeof(wc.sta.ssid));
  strncpy((char *)wc.sta.password, psk, sizeof(wc.sta.password));
  esp_wifi_set_config(WIFI_IF_STA, &wc);
  esp_wifi_start();
  printf("[recovery] joining Wi-Fi \"%s\"\n", ssid);
  return xEventGroupWaitBits(events, GOT_IP, pdFALSE, pdTRUE, pdMS_TO_TICKS(60000)) & GOT_IP;
}

static bool install(const char *url, const char *sha_hex) {
  printf("[recovery] downloading %s\n", url);
  esp_http_client_config_t http = {.url = url, .crt_bundle_attach = esp_crt_bundle_attach, .timeout_ms = 20000, .keep_alive_enable = true};
  esp_https_ota_config_t ota = {.http_config = &http};
  esp_err_t err = esp_https_ota(&ota);  // writes the next OTA slot (app0) and makes it the boot slot
  if (err != ESP_OK) {
    printf("[recovery] download failed: %s\n", esp_err_to_name(err));
    return false;
  }
  const esp_partition_t *app0 = esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_0, NULL);
  uint8_t sha[32];
  char hex[65];
  if (!app0 || esp_partition_get_sha256(app0, sha) != ESP_OK) return false;
  for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", sha[i]);
  // esp_partition_get_sha256 of an app hashes the image as written (what esptool's SHA covers).
  if (sha_hex[0] && strcasecmp(hex, sha_hex) != 0) {
    printf("[recovery] image SHA-256 mismatch (%s)\n", hex);
    return false;
  }
  return true;
}

void app_main(void) {
  printf("\nESP Lab Recovery " RECOVERY_VERSION "\n");
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    nvs_flash_erase();
    nvs_flash_init();
  }
  char url[200], sha[65];
  if (!cfg("fwurl", url, sizeof(url))) {
    boot_app0("no update requested");
    printf("[recovery] no firmware in app0 and no update requested. Flash ESP Lab over USB.\n");
    return;
  }
  cfg("fwsha", sha, sizeof(sha));
  for (int attempt = 1;; attempt++) {
    if (join_wifi() || xEventGroupGetBits(events) & GOT_IP) {
      if (install(url, sha)) {
        set_cfg("fwurl", NULL);
        set_cfg("fwstate", "installed");
        printf("[recovery] firmware installed, restarting\n");
        esp_restart();
      }
    } else {
      printf("[recovery] no Wi-Fi (attempt %d)\n", attempt);
    }
    set_cfg("fwstate", "retrying");
    vTaskDelay(pdMS_TO_TICKS(attempt < 5 ? 10000 : 60000));
  }
}
