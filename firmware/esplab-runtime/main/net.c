// ESP Lab Runtime networking: stored device config, Wi-Fi station and the cloud WebSocket link.
//
// Config lives in NVS (namespace "esplab") and is set over the console:
//   ESPLAB SET ssid=My Network
//   ESPLAB SET psk=secret
//   ESPLAB SET hub=wss://hub.example/v1/device
//   ESPLAB SET token=dev_xxx
//   ESPLAB SETUP              (saves and (re)connects)
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_mac.h"
#include "esp_system.h"
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "net.h"
#include "local.h"

#define NS "esplab"
/** Where devices connect when set up with a setup code (no hub configured explicitly). */
#define DEFAULT_HUB "wss://esp-lab-hub.stern.workers.dev/v1/device"

static esp_websocket_client_handle_t ws;
static volatile bool wifi_up, cloud_up;
static char ip[16];
static bool stack_ready;
static char token_header[160];
static bool claiming;  // connected to /v1/claim to trade a setup code for a device key

void net_heap_report(const char *when) {
  printf("[net] %s: free heap %lu, largest block %lu, minimum ever %lu\n", when,
         (unsigned long)esp_get_free_heap_size(),
         (unsigned long)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
         (unsigned long)esp_get_minimum_free_heap_size());
}

// ---- config ---------------------------------------------------------------------------------

bool net_config_get(const char *key, char *out, size_t size) {
  nvs_handle_t h;
  out[0] = 0;
  if (nvs_open(NS, NVS_READONLY, &h) != ESP_OK) return false;
  size_t len = size;
  esp_err_t err = nvs_get_str(h, key, out, &len);
  nvs_close(h);
  return err == ESP_OK && out[0];
}

bool net_config_set(const char *key, const char *value) {
  static const char *allowed[] = {"ssid", "psk", "hub", "token", "name", "claim", "portal", "local", "lsecret"};
  bool ok = false;
  for (size_t i = 0; i < sizeof(allowed) / sizeof(allowed[0]); i++) ok |= strcmp(key, allowed[i]) == 0;
  if (!ok) return false;
  nvs_handle_t h;
  if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return false;
  esp_err_t err = value[0] ? nvs_set_str(h, key, value) : nvs_erase_key(h, key);
  if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;
  if (err == ESP_OK) err = nvs_commit(h);
  nvs_close(h);
  return err == ESP_OK;
}

// ---- cloud link -----------------------------------------------------------------------------

/** The hub's answer to a setup code: {"t":"claimed","key","hub"} or {"t":"error","message"}. */
static void on_claim_answer(const char *text, size_t len) {
  cJSON *msg = cJSON_ParseWithLength(text, len);
  if (!msg) return;
  const char *t = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "t"));
  if (t && strcmp(t, "claimed") == 0) {
    const char *key = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "key"));
    const char *hub = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "hub"));
    if (key && hub) {
      net_config_set("token", key);
      net_config_set("hub", hub);
      net_config_set("claim", "");
      printf("[net] claimed into an ESP Lab project; restarting to connect\n");
      fflush(stdout);
      esp_restart();
    }
  } else if (t && strcmp(t, "error") == 0) {
    const char *message = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "message"));
    printf("[net] setup code refused: %s\n", message ? message : "?");
    net_config_set("claim", "");
  }
  cJSON_Delete(msg);
}

static void ws_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
  esp_websocket_event_data_t *ev = data;
  switch (id) {
    case WEBSOCKET_EVENT_CONNECTED:
      if (claiming) {
        printf("[net] presenting the setup code to the ESP Lab Hub\n");
        break;
      }
      cloud_up = true;
      printf("[net] cloud connected\n");
      net_heap_report("cloud connected");
      net_on_cloud(true);
      break;
    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_CLOSED:
      if (cloud_up) printf("[net] cloud disconnected\n");
      cloud_up = false;
      net_on_cloud(false);
      break;
    case WEBSOCKET_EVENT_DATA:
      // Text frames only, delivered whole (frames larger than the buffer are dropped).
      if (ev->op_code == 0x1 && ev->payload_offset == 0 && ev->data_len == ev->payload_len) {
        if (claiming) on_claim_answer(ev->data_ptr, ev->data_len);
        else net_on_message(ev->data_ptr, ev->data_len);
      }
      break;
    case WEBSOCKET_EVENT_ERROR:
      printf("[net] cloud link error\n");
      break;
    default:
      break;
  }
}

static void cloud_start(void) {
  static char hub[300];
  char token[120], claim[16];
  if (ws) return;
  bool have_hub = net_config_get("hub", hub, 160);
  bool have_token = net_config_get("token", token, sizeof(token));
  claiming = !have_token && net_config_get("claim", claim, sizeof(claim));
  if (claiming) {
    // Trade the setup code for a device key: wss://…/v1/claim?code=…&chip=…
    if (!have_hub) snprintf(hub, 160, "%s", DEFAULT_HUB);
    char *path = strstr(hub, "/v1/device");
    if (path) *path = 0;
    uint8_t mac[6] = {0};
    esp_efuse_mac_get_default(mac);
    size_t n = strlen(hub);
    snprintf(hub + n, sizeof(hub) - n, "/v1/claim?code=%s&chip=esp32-%02x%02x%02x%02x%02x%02x", claim, mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  } else if (!have_hub) {
    return;
  }
  token_header[0] = 0;
  if (have_token && !claiming) snprintf(token_header, sizeof(token_header), "Authorization: Bearer %s\r\n", token);
  esp_websocket_client_config_t cfg = {
    .uri = hub,
    .headers = token_header[0] ? token_header : NULL,
    .buffer_size = 2048,
    .task_stack = 6 * 1024,
    .reconnect_timeout_ms = 5000,
    .network_timeout_ms = 10000,
    .ping_interval_sec = 20,
    .crt_bundle_attach = esp_crt_bundle_attach,
  };
  ws = esp_websocket_client_init(&cfg);
  if (!ws) {
    printf("[net] cloud link could not start\n");
    return;
  }
  esp_websocket_register_events(ws, WEBSOCKET_EVENT_ANY, ws_event, NULL);
  printf("[net] connecting to %s\n", hub);
  esp_websocket_client_start(ws);
}

static void cloud_stop(void) {
  if (!ws) return;
  esp_websocket_client_destroy(ws);
  ws = NULL;
  cloud_up = false;
}

bool net_cloud_ready(void) { return cloud_up; }

bool net_cloud_send(const char *text, size_t len) {
  if (!ws || !cloud_up) return false;
  return esp_websocket_client_send_text(ws, text, len, pdMS_TO_TICKS(2000)) >= 0;
}

// ---- Wi-Fi ----------------------------------------------------------------------------------

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
    esp_wifi_connect();
  } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
    if (wifi_up) printf("[net] Wi-Fi lost, reconnecting\n");
    wifi_up = false;
    esp_wifi_connect();
  } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    ip_event_got_ip_t *ev = data;
    wifi_up = true;
    snprintf(ip, sizeof(ip), IPSTR, IP2STR(&ev->ip_info.ip));
    printf("[net] Wi-Fi up, IP %s\n", ip);
    net_heap_report("Wi-Fi up");
    clock_start_sntp();
    local_start();
    cloud_start();
  }
}

bool net_wifi_ready(void) { return wifi_up; }

const char *net_ip(void) { return ip; }

void net_start(void) {
  char ssid[33], psk[65];
  if (!net_config_get("ssid", ssid, sizeof(ssid))) {
    printf("[net] no Wi-Fi configured (offline; the console link still works)\n");
    return;
  }
  net_config_get("psk", psk, sizeof(psk));
  if (!stack_ready) {
    esp_netif_init();
    esp_event_loop_create_default();
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    if (esp_wifi_init(&init) != ESP_OK) {
      printf("[net] Wi-Fi init failed\n");
      return;
    }
    esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL);
    esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL);
    esp_wifi_set_storage(WIFI_STORAGE_RAM);
    esp_wifi_set_mode(WIFI_MODE_STA);
    stack_ready = true;
  } else {
    cloud_stop();
    esp_wifi_stop();
  }
  wifi_config_t wc = {0};
  strncpy((char *)wc.sta.ssid, ssid, sizeof(wc.sta.ssid));
  strncpy((char *)wc.sta.password, psk, sizeof(wc.sta.password));
  wc.sta.threshold.authmode = psk[0] ? WIFI_AUTH_WPA_PSK : WIFI_AUTH_OPEN;
  esp_wifi_set_config(WIFI_IF_STA, &wc);
  printf("[net] joining Wi-Fi \"%s\"\n", ssid);
  esp_wifi_start();
}

void net_init(void) {
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    // NVS written by another firmware (e.g. Tasmota) in a newer format: start clean.
    nvs_flash_erase();
    err = nvs_flash_init();
  }
  if (err != ESP_OK) printf("[net] NVS init failed (%d)\n", err);
}
