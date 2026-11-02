// The wall clock without internet. Sources, best first: the hub's "time" frame, NTP (works with
// internet even when the hub is down), the local page (the phone's clock), an RTC chip read by
// the program. The time is saved to flash every 10 minutes; after a restart without any source it
// is restored as "approximate" (behind by the time the board was off), so daily schedules still
// run and the page asks to set the clock.
#include <stdio.h>
#include <sys/time.h>

#include "esp_sntp.h"
#include "esp_timer.h"
#include "nvs.h"

#include "local.h"

#define NS "esplab"
#define SAVE_US (10LL * 60 * 1000000)

static volatile int quality = CLOCK_NONE;
static esp_timer_handle_t save_timer;

static int64_t now_s(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return tv.tv_sec > 1600000000 ? (int64_t)tv.tv_sec : 0;
}

static void save(void *arg) {
  int64_t s = now_s();
  if (!s || quality == CLOCK_NONE) return;
  nvs_handle_t h;
  if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
  if (nvs_set_i64(h, "time", s) == ESP_OK) nvs_commit(h);
  nvs_close(h);
}

int clock_quality(void) { return quality; }

void clock_init(void) {
  esp_timer_create_args_t args = {.callback = save, .name = "clock"};
  if (esp_timer_create(&args, &save_timer) == ESP_OK) esp_timer_start_periodic(save_timer, SAVE_US);
  if (now_s()) {  // kept across a software restart (the RTC timer keeps running)
    quality = CLOCK_APPROX;
    return;
  }
  nvs_handle_t h;
  int64_t saved = 0;
  if (nvs_open(NS, NVS_READONLY, &h) == ESP_OK) {
    nvs_get_i64(h, "time", &saved);
    nvs_close(h);
  }
  if (saved > 1600000000) {
    struct timeval tv = {.tv_sec = saved, .tv_usec = 0};
    settimeofday(&tv, NULL);
    quality = CLOCK_APPROX;
    printf("[clock] no time source yet: using the last saved time (approximate)\n");
  }
}

void clock_synced(void) {
  bool changed = quality != CLOCK_SYNCED;
  quality = CLOCK_SYNCED;
  save(NULL);
  if (changed) clock_changed();
}

static void on_sntp(struct timeval *tv) {
  printf("[clock] set from NTP\n");
  clock_synced();
}

void clock_start_sntp(void) {
  static bool started;
  if (started) return;
  started = true;
  esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);
  esp_sntp_setservername(0, "pool.ntp.org");
  sntp_set_time_sync_notification_cb(on_sntp);
  esp_sntp_init();
}
