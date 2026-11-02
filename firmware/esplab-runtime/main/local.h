// Local control on the LAN (local.c) and the wall clock (clock.c).
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** Starts the local page (http://esplab-xxxxxx.local) once Wi-Fi is up; no-op if disabled or running. */
void local_start(void);
/** Every frame the program sends, for the page's live view. */
void local_on_frame(const char *text, size_t len);
/** Implemented in main.c: a frame from the local page, delivered like one from the cloud. */
void local_deliver(const char *text, size_t len);
/** The 6-digit local access code (from the device key, so the hub can show it too). */
const char *local_code(void);

/** Clock quality: 0 not set, 1 approximate (restored from flash after a restart), 2 synced. */
enum { CLOCK_NONE = 0, CLOCK_APPROX = 1, CLOCK_SYNCED = 2 };
/** At boot: restores the last saved time when the clock is not set. */
void clock_init(void);
/** The clock was set from a trusted source (hub, NTP, the local page, an RTC): save it. */
void clock_synced(void);
/** Starts NTP once Wi-Fi is up. */
void clock_start_sntp(void);
int clock_quality(void);
/** Implemented in main.c: tells the program the clock quality changed. */
void clock_changed(void);
