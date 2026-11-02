// First-time setup without USB: the device opens its own Wi-Fi network "ESPLab-XXXX" and serves a
// small page at http://192.168.4.1 where the user enters the home Wi-Fi and the setup code from
// ESP Lab. The device then restarts, joins the Wi-Fi and claims itself into the project.
//
// Started when a device has no Wi-Fi configured and: it was just converted from Tasmota, the
// BOOT button is held at power-up, or "ESPLAB PORTAL" was sent over the console. Programs do not
// run in setup mode (the radio and the web server need the RAM).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "net.h"

static char ap_name[20];

static const char PAGE_HEAD[] =
  "<!doctype html><html><head><meta name=viewport content='width=device-width,initial-scale=1'>"
  "<title>ESP Lab setup</title><style>body{font:16px system-ui;background:#0b0e12;color:#e6edf3;margin:0;padding:24px}"
  "main{max-width:420px;margin:auto}h1{font-size:20px}label{display:block;margin:14px 0 4px;color:#9aa5b4;font-size:13px}"
  "input,select{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #2a323d;background:#11161c;color:#e6edf3;font-size:16px}"
  "button{margin-top:20px;width:100%;padding:12px;border:0;border-radius:8px;background:#b8f36a;color:#0b0e12;font-weight:600;font-size:16px}"
  "p{color:#9aa5b4;font-size:14px;line-height:1.5}</style></head><body><main>";

/** Decodes application/x-www-form-urlencoded in place. */
static void url_decode(char *s) {
  char *o = s;
  for (; *s; s++, o++) {
    if (*s == '+') *o = ' ';
    else if (*s == '%' && s[1] && s[2]) {
      char hex[3] = {s[1], s[2], 0};
      *o = (char)strtol(hex, NULL, 16);
      s += 2;
    } else *o = *s;
  }
  *o = 0;
}

static void form_value(const char *body, const char *key, char *out, size_t size) {
  out[0] = 0;
  char pattern[24];
  snprintf(pattern, sizeof(pattern), "%s=", key);
  const char *p = body;
  while ((p = strstr(p, pattern))) {
    if (p == body || p[-1] == '&') break;
    p++;
  }
  if (!p) return;
  p += strlen(pattern);
  size_t n = strcspn(p, "&");
  if (n >= size) n = size - 1;
  memcpy(out, p, n);
  out[n] = 0;
  url_decode(out);
}

static esp_err_t page(httpd_req_t *req) {
  httpd_resp_set_type(req, "text/html");
  httpd_resp_sendstr_chunk(req, PAGE_HEAD);
  char chunk[320];
  snprintf(chunk, sizeof(chunk),
           "<h1>Set up %s</h1><p>Connect this device to your Wi-Fi and to your ESP Lab project. Get the setup code "
           "in ESP Lab: project &rarr; Device tab &rarr; <i>Add a device over Wi-Fi</i>.</p><form method=post action=/save>",
           ap_name);
  httpd_resp_sendstr_chunk(req, chunk);
  httpd_resp_sendstr_chunk(req, "<label>Wi-Fi network</label><input name=ssid list=nets required maxlength=32><datalist id=nets>");
  uint16_t count = 20;
  wifi_ap_record_t aps[20];
  if (esp_wifi_scan_get_ap_records(&count, aps) == ESP_OK) {
    for (int i = 0; i < count; i++) {
      snprintf(chunk, sizeof(chunk), "<option value=\"%s\">", (const char *)aps[i].ssid);
      httpd_resp_sendstr_chunk(req, chunk);
    }
  }
  httpd_resp_sendstr_chunk(req,
    "</datalist><label>Wi-Fi password</label><input name=psk type=password maxlength=64>"
    "<label>Setup code</label><input name=code required placeholder='XXXX-XXXX' autocapitalize=characters maxlength=90>"
    "<button>Save and connect</button></form></main></body></html>");
  return httpd_resp_sendstr_chunk(req, NULL);
}

static void restart_later(void *arg) {
  vTaskDelay(pdMS_TO_TICKS(1500));
  esp_restart();
}

static esp_err_t save(httpd_req_t *req) {
  char body[700];
  int len = httpd_req_recv(req, body, sizeof(body) - 1);
  if (len <= 0) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "empty form");
  body[len] = 0;
  char ssid[33], psk[65], code[96];
  form_value(body, "ssid", ssid, sizeof(ssid));
  form_value(body, "psk", psk, sizeof(psk));
  form_value(body, "code", code, sizeof(code));
  // A self-hosted ESP Lab gives codes with its hub: XXXX-XXXX@hub.example.com
  char *at = strchr(code, '@');
  if (at) {
    *at = 0;
    char hub[140];
    snprintf(hub, sizeof(hub), "wss://%s/v1/device", at + 1);
    net_config_set("hub", hub);
  }
  if (!ssid[0] || !code[0]) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Wi-Fi name and setup code are required");
  net_config_set("ssid", ssid);
  net_config_set("psk", psk);
  net_config_set("claim", code);
  net_config_set("portal", "");
  httpd_resp_set_type(req, "text/html");
  httpd_resp_sendstr_chunk(req, PAGE_HEAD);
  char done[260];
  snprintf(done, sizeof(done), "<h1>Saved</h1><p>The device restarts, joins <b>%s</b> and appears in your ESP Lab project "
           "in a minute. You can close this page and reconnect to your usual Wi-Fi.</p></main></body></html>", ssid);
  httpd_resp_sendstr_chunk(req, done);
  httpd_resp_sendstr_chunk(req, NULL);
  printf("[setup] saved Wi-Fi \"%s\" and a setup code; restarting\n", ssid);
  xTaskCreate(restart_later, "restart", 2048, NULL, 5, NULL);
  return ESP_OK;
}

/** Phones probe these to detect a captive portal: answer with the setup page. */
static esp_err_t redirect(httpd_req_t *req) {
  httpd_resp_set_status(req, "302 Found");
  httpd_resp_set_hdr(req, "Location", "http://192.168.4.1/");
  return httpd_resp_send(req, NULL, 0);
}

void portal_start(void) {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
  snprintf(ap_name, sizeof(ap_name), "ESPLab-%02X%02X", mac[4], mac[5]);
  esp_netif_init();
  esp_event_loop_create_default();
  esp_netif_create_default_wifi_ap();
  esp_netif_create_default_wifi_sta();
  wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
  if (esp_wifi_init(&init) != ESP_OK) {
    printf("[setup] Wi-Fi init failed\n");
    return;
  }
  esp_wifi_set_storage(WIFI_STORAGE_RAM);
  esp_wifi_set_mode(WIFI_MODE_APSTA);
  wifi_config_t ap = {.ap = {.channel = 6, .max_connection = 4, .authmode = WIFI_AUTH_OPEN}};
  strncpy((char *)ap.ap.ssid, ap_name, sizeof(ap.ap.ssid));
  ap.ap.ssid_len = strlen(ap_name);
  esp_wifi_set_config(WIFI_IF_AP, &ap);
  esp_wifi_start();
  esp_wifi_scan_start(NULL, true);  // for the network list on the page

  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.max_uri_handlers = 8;
  httpd_handle_t server = NULL;
  if (httpd_start(&server, &config) != ESP_OK) {
    printf("[setup] web server failed\n");
    return;
  }
  httpd_uri_t routes[] = {
    {.uri = "/", .method = HTTP_GET, .handler = page},
    {.uri = "/save", .method = HTTP_POST, .handler = save},
    {.uri = "/generate_204", .method = HTTP_GET, .handler = redirect},
    {.uri = "/hotspot-detect.html", .method = HTTP_GET, .handler = redirect},
    {.uri = "/connecttest.txt", .method = HTTP_GET, .handler = redirect},
  };
  for (size_t i = 0; i < sizeof(routes) / sizeof(routes[0]); i++) httpd_register_uri_handler(server, &routes[i]);
  printf("[setup] setup mode: join the Wi-Fi \"%s\" and open http://192.168.4.1\n", ap_name);
}
