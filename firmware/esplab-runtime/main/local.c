// Local control without internet: a page served by the device itself on the home network, at
// http://<its IP> (ESP Lab shows the address next to the local code). No mDNS: it costs RAM a
// program needs, and phones resolve .local names unreliably. It shows the program's values, settings, outputs and
// state machines, and sends commands and settings, all with the cloud unreachable.
//
// Access needs the 6-digit local code: SHA-256 of the device key's SHA-256 (hex) plus
// ":esplab-local", as a number mod 10^6. The hub keeps that same key hash, so ESP Lab can show the
// code to the device's owner; devices set up over USB without a key use a random secret instead,
// printed on the serial console. 5 wrong codes lock the login for a minute. Sessions are random
// tokens in an HttpOnly, SameSite=Strict cookie (RAM only: a restart logs everyone out); POSTs also
// need an "X-ESPLab" header, which a cross-site form cannot send. Plain HTTP: the ESP32 cannot get
// a certificate for a name on the LAN. "ESPLAB SET local=off" disables the page.
//
//   GET  /             the page                    POST /login   body: the code
//   GET  /info         {"id","fw"}          GET  /poll?since=N   frames after N (session)
//   POST /frame        a cmd, cfg, time or sync frame for the program (session)
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_http_server.h"
#include "esp_mac.h"
#include "esp_heap_caps.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "mbedtls/sha256.h"

#include "local.h"
#include "net.h"

extern const char page_start[] asm("_binary_index_html_gz_start");
extern const char page_end[] asm("_binary_index_html_gz_end");

#define SESSIONS 4
#define FRAMES 12
#define FRAME_BYTES 2048   // other frames kept for polling, besides the last hello
#define FRAME_MAX 4096
/** Free RAM below which the page waits: a TLS handshake to the cloud needs it more (and briefly). */
#define LOW_HEAP 14000

static httpd_handle_t server;
static SemaphoreHandle_t lock;
static char code[7];
static char host[24];
static char sessions[SESSIONS][33];
static int next_session;
static int failures;
static int64_t locked_until;
static bool used;  // a page polled in the last minute: keep frames
static int64_t last_poll;

static char *hello;
static uint32_t hello_seq;
static struct { char *text; uint32_t seq; } frames[FRAMES];
static int frame_head;  // next slot
static size_t frame_bytes;
static uint32_t seq;

// ---- the code ---------------------------------------------------------------------------------

static void hex(const uint8_t *in, size_t n, char *out) {
  for (size_t i = 0; i < n; i++) sprintf(out + i * 2, "%02x", in[i]);
}

static void derive_code(void) {
  char key[160], secret[65];
  uint8_t d[32];
  char key_hash[65];
  if (net_config_get("token", key, sizeof(key))) {
    mbedtls_sha256((const uint8_t *)key, strlen(key), d, 0);
    hex(d, 32, key_hash);
  } else {
    if (!net_config_get("lsecret", secret, sizeof(secret))) {
      uint8_t r[16];
      esp_fill_random(r, sizeof(r));
      hex(r, sizeof(r), secret);
      net_config_set("lsecret", secret);
    }
    snprintf(key_hash, sizeof(key_hash), "%s", secret);
  }
  char material[96];
  int n = snprintf(material, sizeof(material), "%s:esplab-local", key_hash);
  mbedtls_sha256((const uint8_t *)material, n, d, 0);
  uint32_t v = ((uint32_t)d[0] << 24) | ((uint32_t)d[1] << 16) | ((uint32_t)d[2] << 8) | d[3];
  snprintf(code, sizeof(code), "%06lu", (unsigned long)(v % 1000000));
}

const char *local_code(void) {
  if (!code[0]) derive_code();
  return code;
}

// ---- frames -------------------------------------------------------------------------------------

/** Frees the kept frames (nobody is looking: the RAM goes back to the program and TLS). */
static void release_frames(void) {
  free(hello);
  hello = NULL;
  for (int i = 0; i < FRAMES; i++) { free(frames[i].text); frames[i].text = NULL; }
  frame_bytes = 0;
  used = false;
}

void local_on_frame(const char *text, size_t len) {
  if (!used || !lock || len == 0) return;
  if (esp_timer_get_time() - last_poll > 60LL * 1000000) {
    xSemaphoreTake(lock, portMAX_DELAY);
    release_frames();
    xSemaphoreGive(lock);
    return;
  }
  bool is_hello = len > 12 && strncmp(text, "{\"t\":\"hello\"", 12) == 0;
  if (!is_hello && (len > FRAME_MAX || heap_caps_get_free_size(MALLOC_CAP_8BIT) < LOW_HEAP)) return;
  char *copy = malloc(len + 1);
  if (!copy) return;
  memcpy(copy, text, len);
  copy[len] = 0;
  xSemaphoreTake(lock, portMAX_DELAY);
  seq++;
  if (is_hello) {
    free(hello);
    hello = copy;
    hello_seq = seq;
  } else {
    // The slot being reused holds the oldest frame; then drop more of the oldest until this one fits.
    for (int i = 0; i < FRAMES && (frames[frame_head].text || frame_bytes + len > FRAME_BYTES); i++) {
      int slot = (frame_head + i) % FRAMES;
      if (!frames[slot].text) continue;
      frame_bytes -= strlen(frames[slot].text);
      free(frames[slot].text);
      frames[slot].text = NULL;
    }
    frames[frame_head].text = copy;
    frames[frame_head].seq = seq;
    frame_head = (frame_head + 1) % FRAMES;
    frame_bytes += len;
  }
  xSemaphoreGive(lock);
}

// ---- sessions -----------------------------------------------------------------------------------

static bool authorized(httpd_req_t *req) {
  char cookie[80];
  size_t n = sizeof(cookie);
  if (httpd_req_get_cookie_val(req, "s", cookie, &n) != ESP_OK || strlen(cookie) != 32) return false;
  bool found = false;
  for (int i = 0; i < SESSIONS; i++) {
    if (!sessions[i][0]) continue;
    uint8_t diff = 0;  // constant time
    for (int k = 0; k < 32; k++) diff |= (uint8_t)(sessions[i][k] ^ cookie[k]);
    found |= diff == 0;
  }
  return found;
}

static bool busy(httpd_req_t *req) {
  if (heap_caps_get_free_size(MALLOC_CAP_8BIT) >= LOW_HEAP) return false;
  httpd_resp_set_status(req, "503 Service Unavailable");
  httpd_resp_set_hdr(req, "Retry-After", "1");
  httpd_resp_send(req, NULL, 0);
  return true;
}

static esp_err_t deny(httpd_req_t *req) {
  httpd_resp_set_status(req, "401 Unauthorized");
  httpd_resp_set_type(req, "application/json");
  return httpd_resp_sendstr(req, "{\"error\":\"log in with the local code\"}");
}

static int read_body(httpd_req_t *req, char *buf, size_t cap) {
  if (req->content_len >= cap) return -1;
  size_t got = 0;
  while (got < req->content_len) {
    int r = httpd_req_recv(req, buf + got, req->content_len - got);
    if (r <= 0) return -1;
    got += r;
  }
  buf[got] = 0;
  return (int)got;
}

// ---- routes -------------------------------------------------------------------------------------

static esp_err_t get_page(httpd_req_t *req) {
  if (busy(req)) return ESP_OK;
  httpd_resp_set_type(req, "text/html; charset=utf-8");
  httpd_resp_set_hdr(req, "Cache-Control", "no-cache");
  httpd_resp_set_hdr(req, "Content-Encoding", "gzip");  // gzipped at build time (CMakeLists.txt)
  return httpd_resp_send(req, page_start, page_end - page_start);
}

static esp_err_t get_info(httpd_req_t *req) {
  char out[160];
  uint8_t mac[6] = {0};
  esp_efuse_mac_get_default(mac);
  snprintf(out, sizeof(out), "{\"id\":\"esp32-%02x%02x%02x%02x%02x%02x\",\"fw\":\"%s\",\"host\":\"%s\"}",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5], net_runtime_version(), host);
  httpd_resp_set_type(req, "application/json");
  return httpd_resp_sendstr(req, out);
}

static esp_err_t post_login(httpd_req_t *req) {
  if (busy(req)) return ESP_OK;
  char body[64];
  int64_t now = esp_timer_get_time();
  httpd_resp_set_type(req, "application/json");
  if (now < locked_until) {
    httpd_resp_set_status(req, "429 Too Many Requests");
    return httpd_resp_sendstr(req, "{\"error\":\"too many wrong codes: wait a minute\"}");
  }
  if (read_body(req, body, sizeof(body)) < 0) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad body");
  char digits[8] = {0};
  int k = 0;
  for (char *p = body; *p && k < 7; p++) if (*p >= '0' && *p <= '9') digits[k++] = *p;
  const char *want = local_code();
  uint8_t diff = k != 6;
  for (int i = 0; i < 6; i++) diff |= (uint8_t)(digits[i] ^ want[i]);
  if (diff) {
    if (++failures >= 5) {
      failures = 0;
      locked_until = now + 60LL * 1000000;
    }
    httpd_resp_set_status(req, "401 Unauthorized");
    return httpd_resp_sendstr(req, "{\"error\":\"wrong code\"}");
  }
  failures = 0;
  uint8_t r[16];
  esp_fill_random(r, sizeof(r));
  char token[33];
  hex(r, sizeof(r), token);
  memcpy(sessions[next_session], token, 33);
  next_session = (next_session + 1) % SESSIONS;
  used = true;
  last_poll = esp_timer_get_time();
  char cookie[96];
  snprintf(cookie, sizeof(cookie), "s=%s; Path=/; HttpOnly; SameSite=Strict", token);
  httpd_resp_set_hdr(req, "Set-Cookie", cookie);
  return httpd_resp_sendstr(req, "{\"ok\":true}");
}

static esp_err_t get_poll(httpd_req_t *req) {
  if (busy(req)) return ESP_OK;
  if (!authorized(req)) return deny(req);
  char query[32], value[12];
  uint32_t since = 0;
  if (httpd_req_get_url_query_str(req, query, sizeof(query)) == ESP_OK && httpd_query_key_value(query, "since", value, sizeof(value)) == ESP_OK) {
    since = strtoul(value, NULL, 10);
  }
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  xSemaphoreTake(lock, portMAX_DELAY);
  used = true;
  last_poll = esp_timer_get_time();
  if (since > seq) since = 0;  // the device restarted
  char head[64];
  snprintf(head, sizeof(head), "{\"seq\":%lu,\"clock\":%d,\"frames\":[", (unsigned long)seq, clock_quality());
  httpd_resp_sendstr_chunk(req, head);
  bool first = true;
  if (hello && hello_seq > since) {
    httpd_resp_sendstr_chunk(req, hello);
    first = false;
  }
  for (int i = 0; i < FRAMES; i++) {
    int slot = (frame_head + i) % FRAMES;  // oldest first
    if (!frames[slot].text || frames[slot].seq <= since) continue;
    if (!first) httpd_resp_sendstr_chunk(req, ",");
    httpd_resp_sendstr_chunk(req, frames[slot].text);
    first = false;
  }
  xSemaphoreGive(lock);
  httpd_resp_sendstr_chunk(req, "]}");
  return httpd_resp_sendstr_chunk(req, NULL);
}

static esp_err_t post_frame(httpd_req_t *req) {
  if (busy(req)) return ESP_OK;
  if (!authorized(req)) return deny(req);
  char marker[4];
  if (httpd_req_get_hdr_value_str(req, "X-ESPLab", marker, sizeof(marker)) != ESP_OK) return deny(req);
  char *body = malloc(2048);
  if (!body) return httpd_resp_send_500(req);
  int len = read_body(req, body, 2048);
  bool ok = false;
  if (len > 0) {
    cJSON *msg = cJSON_ParseWithLength(body, len);
    const char *t = msg ? cJSON_GetStringValue(cJSON_GetObjectItem(msg, "t")) : NULL;
    // Only what an app may send: no deploys, firmware updates or claims.
    ok = t && (!strcmp(t, "cmd") || !strcmp(t, "cfg") || !strcmp(t, "time") || !strcmp(t, "sync"));
    if (ok && !strcmp(t, "cfg")) {
      cJSON_DeleteItemFromObject(msg, "ver");  // a local change never claims a cloud version
      cJSON_DeleteItemFromObject(msg, "local");
      cJSON_AddTrueToObject(msg, "local");
      char *text = cJSON_PrintUnformatted(msg);
      if (text) { local_deliver(text, strlen(text)); cJSON_free(text); }
    } else if (ok) {
      local_deliver(body, len);
    }
    cJSON_Delete(msg);
  }
  free(body);
  httpd_resp_set_type(req, "application/json");
  if (!ok) {
    httpd_resp_set_status(req, "400 Bad Request");
    return httpd_resp_sendstr(req, "{\"error\":\"only cmd, cfg, time and sync frames\"}");
  }
  return httpd_resp_sendstr(req, "{\"ok\":true}");
}

void local_start(void) {
  char setting[8];
  if (server) return;
  if (net_config_get("local", setting, sizeof(setting)) && !strcmp(setting, "off")) {
    printf("[local] local page disabled (ESPLAB SET local=off)\n");
    return;
  }
  if (!lock) lock = xSemaphoreCreateMutex();
  uint8_t mac[6] = {0};
  esp_efuse_mac_get_default(mac);
  snprintf(host, sizeof(host), "esplab-%02x%02x%02x", mac[3], mac[4], mac[5]);

  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.max_open_sockets = 2;
  config.stack_size = 4096;
  config.lru_purge_enable = true;
  if (httpd_start(&server, &config) != ESP_OK) {
    printf("[local] local page could not start\n");
    server = NULL;
    return;
  }
  httpd_uri_t routes[] = {
    {.uri = "/", .method = HTTP_GET, .handler = get_page},
    {.uri = "/info", .method = HTTP_GET, .handler = get_info},
    {.uri = "/login", .method = HTTP_POST, .handler = post_login},
    {.uri = "/poll", .method = HTTP_GET, .handler = get_poll},
    {.uri = "/frame", .method = HTTP_POST, .handler = post_frame},
  };
  for (size_t i = 0; i < sizeof(routes) / sizeof(routes[0]); i++) httpd_register_uri_handler(server, &routes[i]);

  printf("[local] local page: http://%s (local code %s)\n", net_ip(), local_code());
}
