// Numbers and JSON for programs (runtime 0.13): formatting, parsing, reading the current
// message and building outgoing frames, so programs don't carry that code (labhost.c).
#pragma once
#include <stddef.h>

/** Registers the "esp" functions of labhost.c with WAMR. */
void labhost_register(void);
/** Implemented in main.c: sends one frame (UTF-8 JSON) like esp.send does. */
void labhost_send_frame(const char *text, size_t len);
