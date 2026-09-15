#include "../firmware/input_tool/InputProtocol.h"
#include <assert.h>
#include <stdio.h>

int main() {
  InputRecord sequence[] = {{1,0,'h',0,0},{2,1,0,0,0},{2,1,120,0,0},{2,0,0,0,0},{3,100,0,0,0}};
  assert(validateInput(sequence,5));
  assert(!validateInput(sequence,0));
  assert(!validateInput(sequence,3));
  sequence[0].a=16; assert(!validateInput(sequence,5)); sequence[0].a=0;
  sequence[2].b=128; assert(!validateInput(sequence,5)); sequence[2].b=120;
  sequence[4]={3,255,255,0,0}; assert(!validateInput(sequence,5));
  sequence[4]={3,0,0,0,1}; assert(!validateInput(sequence,5));
  sequence[4]={2,0,0,0,255}; assert(validateInput(sequence,5));
  sequence[2]={3,1,0,0,0}; assert(!validateInput(sequence,5));
  puts("Firmware input validation passed.");
}
