#pragma once
#include <stdbool.h>
#include <stddef.h>

void net_init(void);
/** Joins the configured Wi-Fi (if any), then opens the cloud link (if a hub is configured). */
void net_start(void);
bool net_wifi_ready(void);
/** The station's IP address ("" before Wi-Fi is up). */
const char *net_ip(void);
bool net_cloud_ready(void);
bool net_cloud_send(const char *text, size_t len);
bool net_config_get(const char *key, char *out, size_t size);
bool net_config_set(const char *key, const char *value);
void net_heap_report(const char *when);
/** "0.12" etc. (main.c). */
const char *net_runtime_version(void);

/** Callbacks into main.c. */
void net_on_cloud(bool up);
void net_on_message(const char *text, size_t len);
