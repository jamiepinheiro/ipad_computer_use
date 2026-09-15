#pragma once
#include <stddef.h>
#include <stdint.h>

struct InputRecord { uint8_t type, a, b, c, d; };

inline bool validKey(uint8_t modifier, uint8_t key) {
  return modifier <= 15 && ((key >= 32 && key <= 126) || (key >= 176 && key <= 179) ||
                           (key >= 194 && key <= 205) || (key >= 210 && key <= 218));
}

inline bool validateInput(const InputRecord *records, size_t count) {
  if (!count || count > 512) return false;
  uint32_t waits = 0;
  uint8_t lastButtons = 0;
  for (size_t i = 0; i < count; i++) {
    const auto &r = records[i];
    if (r.type == 1) {
      if (!validKey(r.a, r.b) || r.c || r.d || lastButtons) return false;
    } else if (r.type == 2) {
      if (r.a > 7 || r.b == 128 || r.c == 128 || r.d == 128) return false;
      lastButtons = r.a;
    } else if (r.type == 3) {
      if (r.c || r.d || lastButtons) return false;
      waits += r.a | (uint32_t(r.b) << 8);
      if (waits > 10000) return false;
    } else return false;
  }
  // Every batch must release its own buttons, including a drag.
  return lastButtons == 0;
}
