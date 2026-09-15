#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/test
for name in input onboard_lights; do
  "${CXX:-c++}" -std=c++17 -Wall -Wextra -Werror "test/$name.test.cpp" -o "build/test/$name"
  "build/test/$name"
done
