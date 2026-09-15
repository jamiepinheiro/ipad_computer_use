#pragma once
#include <stdint.h>
#ifdef __cplusplus
#include <Arduino.h>
void diagnosticsBegin();
void diagnosticsPoll();
void diagnosticsDump(Print &output);
extern "C" {
#endif
void input_tool_trace(uint32_t event, uint32_t a, uint32_t b, uint32_t c);
#ifdef __cplusplus
}
#endif
