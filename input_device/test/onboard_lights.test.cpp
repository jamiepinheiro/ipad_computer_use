#include <cassert>
#include "../firmware/input_tool/OnboardLights.h"

int main() {
  assert(onboardLight(false, false, false, false, false, false) == Light::Yellow);
  assert(onboardLight(true, false, false, false, false, false) == Light::Blue);
  assert(onboardLight(true, false, true, true, false, false) == Light::Yellow);
  assert(onboardLight(true, false, true, false, false, true) == Light::Cyan);
  assert(onboardLight(true, false, false, false, false, true) == Light::Green);
  assert(onboardLight(true, false, true, false, true, true) == Light::Red);
  assert(onboardLight(true, true, true, false, true, true) == Light::Off);
}
