// Numbers and JSON for programs (runtime 0.13). Programs used to carry number formatting and
// parsing, a JSON parser and a frame writer: several KB of bytecode in every program, in RAM.
// The firmware does it here instead, in flash. The rules match the test hosts in
// packages/runtime-sdk/src/numfmt.ts and json-host.ts, so tests and devices agree.
//
// Strings cross as UTF-16 (AssemblyScript's encoding): pointer + byte length.
#include "labhost.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "wasm_export.h"

// ---- UTF-16 <-> UTF-8 ----------------------------------------------------------------------

/** Appends UTF-16 text as UTF-8 through put(); surrogate pairs become 4-byte sequences. */
static void utf16_each(const uint8_t *buf, uint32_t bytes, void (*put)(const char *, size_t)) {
  char out[4];
  for (uint32_t i = 0; i + 2 <= bytes; i += 2) {
    uint32_t c = buf[i] | (buf[i + 1] << 8);
    if (c >= 0xD800 && c < 0xDC00 && i + 4 <= bytes) {
      uint32_t d = buf[i + 2] | (buf[i + 3] << 8);
      if (d >= 0xDC00 && d < 0xE000) {
        c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00);
        i += 2;
      }
    }
    if (c < 0x80) {
      out[0] = (char)c;
      put(out, 1);
    } else if (c < 0x800) {
      out[0] = 0xC0 | (c >> 6);
      out[1] = 0x80 | (c & 0x3F);
      put(out, 2);
    } else if (c < 0x10000) {
      out[0] = 0xE0 | (c >> 12);
      out[1] = 0x80 | ((c >> 6) & 0x3F);
      out[2] = 0x80 | (c & 0x3F);
      put(out, 3);
    } else {
      out[0] = 0xF0 | (c >> 18);
      out[1] = 0x80 | ((c >> 12) & 0x3F);
      out[2] = 0x80 | ((c >> 6) & 0x3F);
      out[3] = 0x80 | (c & 0x3F);
      put(out, 4);
    }
  }
}

/** UTF-8 to UTF-16 into out (cap bytes). Returns the bytes written, or -1 if it doesn't fit. */
static int32_t utf8_to_utf16(const char *s, size_t len, uint8_t *out, uint32_t cap) {
  uint32_t n = 0;
  for (size_t i = 0; i < len;) {
    uint32_t c = (uint8_t)s[i];
    int extra = c < 0x80 ? 0 : c < 0xE0 ? 1 : c < 0xF0 ? 2 : 3;
    if (extra) c &= extra == 1 ? 0x1F : extra == 2 ? 0x0F : 0x07;
    i++;
    for (int k = 0; k < extra && i < len; k++, i++) c = (c << 6) | ((uint8_t)s[i] & 0x3F);
    if (c >= 0x10000) {
      if (n + 4 > cap) return -1;
      uint32_t v = c - 0x10000, hi = 0xD800 + (v >> 10), lo = 0xDC00 + (v & 0x3FF);
      out[n++] = hi & 0xFF; out[n++] = hi >> 8; out[n++] = lo & 0xFF; out[n++] = lo >> 8;
    } else {
      if (n + 2 > cap) return -1;
      out[n++] = c & 0xFF;
      out[n++] = c >> 8;
    }
  }
  return (int32_t)n;
}

/** A short UTF-16 key as a C string (object keys in messages). */
static void key_text(const uint8_t *buf, uint32_t bytes, char *out, size_t cap) {
  size_t n = 0;
  for (uint32_t i = 0; i + 2 <= bytes && n + 1 < cap; i += 2) {
    uint16_t c = buf[i] | (buf[i + 1] << 8);
    out[n++] = c < 0x80 ? (char)c : '?';
  }
  out[n] = 0;
}

// ---- numbers -------------------------------------------------------------------------------

/** Shortest digits that read back exactly, laid out as JavaScript's Number#toString does. */
static void shortest(double v, char *out, size_t cap) {
  char e[40];
  for (int p = 1; p <= 17; p++) {
    snprintf(e, sizeof(e), "%.*e", p - 1, v);
    if (strtod(e, NULL) == v) break;
  }
  const char *s = e;
  bool neg = *s == '-';
  if (neg) s++;
  char digits[24];
  int nd = 0;
  while (*s && *s != 'e' && nd < 20) {
    if (*s >= '0' && *s <= '9') digits[nd++] = *s;
    s++;
  }
  int exp = *s == 'e' ? atoi(s + 1) : 0;
  while (nd > 1 && digits[nd - 1] == '0') nd--;
  size_t o = 0;
#define PUT(c) do { if (o + 1 < cap) out[o++] = (c); } while (0)
  if (neg) PUT('-');
  int n = exp + 1;  // digits before the point
  if (n > -6 && n <= 21) {
    if (n <= 0) {
      PUT('0');
      PUT('.');
      for (int i = 0; i < -n; i++) PUT('0');
      for (int i = 0; i < nd; i++) PUT(digits[i]);
    } else {
      for (int i = 0; i < n || i < nd; i++) {
        if (i == n) PUT('.');
        PUT(i < nd ? digits[i] : '0');
      }
    }
  } else {
    PUT(digits[0]);
    if (nd > 1) {
      PUT('.');
      for (int i = 1; i < nd; i++) PUT(digits[i]);
    }
    PUT('e');
    PUT(exp >= 0 ? '+' : '-');
    char x[12];
    snprintf(x, sizeof(x), "%d", exp >= 0 ? exp : -exp);
    for (char *c = x; *c; c++) PUT(*c);
  }
#undef PUT
  out[o] = 0;
}

/** decimals >= 0: fixed (at most 9); < 0: whole numbers without decimals, others shortest. */
static void format_number(double v, int decimals, char *out, size_t cap) {
  if (isnan(v)) { snprintf(out, cap, "NaN"); return; }
  if (isinf(v)) { snprintf(out, cap, v > 0 ? "Infinity" : "-Infinity"); return; }
  if (v == 0) v = 0;  // no "-0"
  if (decimals >= 0) { snprintf(out, cap, "%.*f", decimals > 9 ? 9 : decimals, v); return; }
  if (v == floor(v) && fabs(v) < 1e15) { snprintf(out, cap, "%.0f", v); return; }
  shortest(v, out, cap);
}

/** A number in a frame: null when not finite, whole numbers as integers, others to 3 decimals. */
static void json_number(double v, char *out, size_t cap) {
  if (!isfinite(v)) { snprintf(out, cap, "null"); return; }
  if (v == floor(v) && fabs(v) < 1e15) { format_number(v, -1, out, cap); return; }
  format_number(floor(v * 1000 + 0.5) / 1000, -1, out, cap);
}

static void lab_print_num(wasm_exec_env_t env, double v, int32_t decimals) {
  char text[40];
  format_number(v, decimals, text, sizeof(text));
  fputs(text, stdout);
  fflush(stdout);
}

static int32_t lab_fmt_num(wasm_exec_env_t env, double v, int32_t decimals, uint8_t *out, uint32_t cap) {
  char text[40];
  format_number(v, decimals, text, sizeof(text));
  int32_t n = utf8_to_utf16(text, strlen(text), out, cap);
  return n < 0 ? 0 : n;
}

/** The number at the start of the text, as parseFloat() reads it; NaN when there is none. */
static double lab_parse_num(wasm_exec_env_t env, const uint8_t *buf, uint32_t bytes) {
  char s[64];
  key_text(buf, bytes, s, sizeof(s));
  const char *p = s;
  while (*p && (unsigned char)*p <= 32) p++;
  char span[64];
  size_t n = 0;
  if (*p == '+' || *p == '-') span[n++] = *p++;
  if (strncmp(p, "Infinity", 8) == 0) return n && span[0] == '-' ? -INFINITY : INFINITY;
  bool digits = false;
  while (*p >= '0' && *p <= '9' && n < 60) { span[n++] = *p++; digits = true; }
  if (*p == '.' && n < 60) {
    span[n++] = *p++;
    while (*p >= '0' && *p <= '9' && n < 60) { span[n++] = *p++; digits = true; }
  }
  if (!digits) return NAN;
  if ((*p == 'e' || *p == 'E') && ((p[1] >= '0' && p[1] <= '9') || ((p[1] == '+' || p[1] == '-') && p[2] >= '0' && p[2] <= '9'))) {
    span[n++] = *p++;
    if (*p == '+' || *p == '-') span[n++] = *p++;
    while (*p >= '0' && *p <= '9' && n < 62) span[n++] = *p++;
  }
  span[n] = 0;
  return strtod(span, NULL);
}

// ---- the current message -------------------------------------------------------------------
//
// The program hands a received frame to msgLoad (the event buffer, UTF-8, or a UTF-16 string
// from a radio) and reads fields with msgNum / msgStr / msgKind / msgKey, so it needs no parser.

static cJSON *msg;
static char *msg_text;
static size_t msg_len, msg_cap;

static void msg_put(const char *s, size_t n) {
  if (msg_len + n + 1 > msg_cap) {
    size_t cap = (msg_len + n + 1) * 2;
    char *grown = realloc(msg_text, cap);
    if (!grown) return;
    msg_text = grown;
    msg_cap = cap;
  }
  memcpy(msg_text + msg_len, s, n);
  msg_len += n;
}

enum { MSG_OTHER = 0, MSG_CMD = 1, MSG_CFG = 2, MSG_TIME = 3, MSG_SYNC = 4, MSG_EVT = 5, MSG_SUB = 6 };

static int32_t lab_msg_load(wasm_exec_env_t env, const uint8_t *buf, uint32_t bytes, int32_t utf16) {
  cJSON_Delete(msg);
  msg = NULL;
  if (utf16) {
    msg_len = 0;
    utf16_each(buf, bytes, msg_put);
    msg = cJSON_ParseWithLength(msg_text ? msg_text : "", msg_len);
  } else {
    msg = cJSON_ParseWithLength((const char *)buf, bytes);
  }
  if (!cJSON_IsObject(msg)) return MSG_OTHER;
  const char *t = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(msg, "t"));
  if (!t) return MSG_OTHER;
  if (!strcmp(t, "cmd")) return MSG_CMD;
  if (!strcmp(t, "cfg")) return MSG_CFG;
  if (!strcmp(t, "time")) return MSG_TIME;
  if (!strcmp(t, "sync")) return MSG_SYNC;
  if (!strcmp(t, "evt")) return MSG_EVT;
  if (!strcmp(t, "sub")) return MSG_SUB;
  return MSG_OTHER;
}

/** msg[key] (the whole message for ""), then [sub] when sub is not "". */
static cJSON *msg_node(const uint8_t *k, uint32_t kb, const uint8_t *s, uint32_t sb) {
  char key[48], sub[48];
  key_text(k, kb, key, sizeof(key));
  key_text(s, sb, sub, sizeof(sub));
  cJSON *node = msg;
  if (node && key[0]) node = cJSON_GetObjectItemCaseSensitive(node, key);
  if (node && sub[0]) node = cJSON_IsObject(node) ? cJSON_GetObjectItemCaseSensitive(node, sub) : NULL;
  return node;
}

static double lab_msg_num(wasm_exec_env_t env, const uint8_t *k, uint32_t kb, const uint8_t *s, uint32_t sb) {
  cJSON *node = msg_node(k, kb, s, sb);
  if (cJSON_IsNumber(node)) return node->valuedouble;
  if (cJSON_IsBool(node)) return cJSON_IsTrue(node) ? 1 : 0;
  return NAN;
}

static int32_t lab_msg_str(wasm_exec_env_t env, const uint8_t *k, uint32_t kb, const uint8_t *s, uint32_t sb, uint8_t *out, uint32_t cap) {
  const char *text = cJSON_GetStringValue(msg_node(k, kb, s, sb));
  return text ? utf8_to_utf16(text, strlen(text), out, cap) : -1;
}

/** 0 missing, 1 null, 2 bool, 3 number, 4 string, 5 object, 6 array. */
static int32_t lab_msg_kind(wasm_exec_env_t env, const uint8_t *k, uint32_t kb, const uint8_t *s, uint32_t sb) {
  cJSON *node = msg_node(k, kb, s, sb);
  if (!node) return 0;
  if (cJSON_IsNull(node)) return 1;
  if (cJSON_IsBool(node)) return 2;
  if (cJSON_IsNumber(node)) return 3;
  if (cJSON_IsString(node)) return 4;
  if (cJSON_IsObject(node)) return 5;
  if (cJSON_IsArray(node)) return 6;
  return 0;
}

/** The name of the index-th key of the object msg[key]; -1 past the end. */
static int32_t lab_msg_key(wasm_exec_env_t env, const uint8_t *k, uint32_t kb, int32_t index, uint8_t *out, uint32_t cap) {
  cJSON *node = msg_node(k, kb, (const uint8_t *)"", 0);
  if (!cJSON_IsObject(node)) return -1;
  cJSON *item = node->child;
  for (int32_t i = 0; item && i < index; i++) item = item->next;
  return item && item->string ? utf8_to_utf16(item->string, strlen(item->string), out, cap) : -1;
}

// ---- outgoing frames -----------------------------------------------------------------------
//
// jBegin, then jRaw / jStr / jKey / jNum / jCh / jMsg, then jSend (or jTake for a radio).

#define FRAME_MAX 32768
static char *fb;
static size_t fb_len, fb_cap;
static bool fb_bad;

static void fb_put(const char *s, size_t n) {
  if (fb_bad) return;
  if (fb_len + n + 1 > fb_cap) {
    size_t cap = fb_cap ? fb_cap : 1024;
    while (cap < fb_len + n + 1) cap *= 2;
    char *grown = cap <= FRAME_MAX ? realloc(fb, cap) : NULL;
    if (!grown) { fb_bad = true; return; }
    fb = grown;
    fb_cap = cap;
  }
  memcpy(fb + fb_len, s, n);
  fb_len += n;
}

static void fb_put_escaped(const char *s, size_t n) {
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c == '"' || c == '\\') { char e[2] = {'\\', (char)c}; fb_put(e, 2); }
    else if (c == '\n') fb_put("\\n", 2);
    else if (c < 32) fb_put(" ", 1);
    else fb_put((const char *)&s[i], 1);
  }
}

static void lab_j_begin(wasm_exec_env_t env) { fb_len = 0; fb_bad = false; }

static void lab_j_ch(wasm_exec_env_t env, int32_t c) {
  uint8_t unit[2] = {(uint8_t)(c & 0xFF), (uint8_t)((c >> 8) & 0xFF)};
  utf16_each(unit, 2, fb_put);
}

static void lab_j_raw(wasm_exec_env_t env, const uint8_t *buf, uint32_t bytes) { utf16_each(buf, bytes, fb_put); }

static void lab_j_str(wasm_exec_env_t env, const uint8_t *buf, uint32_t bytes) {
  fb_put("\"", 1);
  utf16_each(buf, bytes, fb_put_escaped);
  fb_put("\"", 1);
}

static void lab_j_key(wasm_exec_env_t env, const uint8_t *buf, uint32_t bytes, int32_t first) {
  if (!first) fb_put(",", 1);
  lab_j_str(env, buf, bytes);
  fb_put(":", 1);
}

static void lab_j_num(wasm_exec_env_t env, double v) {
  char text[40];
  json_number(v, text, sizeof(text));
  fb_put(text, strlen(text));
}

/** The JSON of msg[key] (the whole message for ""), or null. */
static void lab_j_msg(wasm_exec_env_t env, const uint8_t *k, uint32_t kb) {
  cJSON *node = msg_node(k, kb, (const uint8_t *)"", 0);
  char *text = node ? cJSON_PrintUnformatted(node) : NULL;
  if (text) { fb_put(text, strlen(text)); cJSON_free(text); }
  else fb_put("null", 4);
}

static void lab_j_send(wasm_exec_env_t env) {
  if (fb_bad) { printf("[lab] frame too large, dropped\n"); return; }
  if (!fb_len) return;
  fb[fb_len] = 0;
  labhost_send_frame(fb, fb_len);
}

/** The frame as UTF-16 (radio transports send it themselves). Returns the bytes, or -1. */
static int32_t lab_j_take(wasm_exec_env_t env, uint8_t *out, uint32_t cap) {
  if (fb_bad) return -1;
  return utf8_to_utf16(fb ? fb : "", fb_len, out, cap);
}

static NativeSymbol labhost_symbols[] = {
  {"printNum", lab_print_num, "(Fi)", NULL},
  {"fmtNum", lab_fmt_num, "(Fi*~)i", NULL},
  {"parseNum", lab_parse_num, "(*~)F", NULL},
  {"msgLoad", lab_msg_load, "(*~i)i", NULL},
  {"msgNum", lab_msg_num, "(*~*~)F", NULL},
  {"msgStr", lab_msg_str, "(*~*~*~)i", NULL},
  {"msgKind", lab_msg_kind, "(*~*~)i", NULL},
  {"msgKey", lab_msg_key, "(*~i*~)i", NULL},
  {"jBegin", lab_j_begin, "()", NULL},
  {"jCh", lab_j_ch, "(i)", NULL},
  {"jRaw", lab_j_raw, "(*~)", NULL},
  {"jStr", lab_j_str, "(*~)", NULL},
  {"jKey", lab_j_key, "(*~i)", NULL},
  {"jNum", lab_j_num, "(F)", NULL},
  {"jMsg", lab_j_msg, "(*~)", NULL},
  {"jSend", lab_j_send, "()", NULL},
  {"jTake", lab_j_take, "(*~)i", NULL},
};

void labhost_register(void) {
  wasm_runtime_register_natives("esp", labhost_symbols, sizeof(labhost_symbols) / sizeof(labhost_symbols[0]));
}
