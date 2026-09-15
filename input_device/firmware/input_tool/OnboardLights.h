#pragma once
#include <stdint.h>

enum class Light : uint8_t { Off, Blue, Yellow, Cyan, Green, Red };

inline Light onboardLight(bool mounted, bool suspended, bool running,
                          bool queued, bool error, bool success) {
  if (suspended) return Light::Off;
  if (error) return Light::Red;
  if (!mounted) return Light::Yellow;
  if (running) return queued ? Light::Yellow : Light::Cyan;
  return success ? Light::Green : Light::Blue;
}
