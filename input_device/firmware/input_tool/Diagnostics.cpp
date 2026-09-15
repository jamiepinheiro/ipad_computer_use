#include "Diagnostics.h"
#include <LittleFS.h>
#include <hardware/sync.h>
#include <tusb.h>

struct Event {uint32_t ms, type, a, b, c;};
static Event events[512];
static volatile uint32_t eventCount=0, dropped=0;
static bool storageReady=false, savedFirst=false, savedFinal=false;
static uint32_t lastFlags=0xffffffff;

extern "C" void input_tool_trace(uint32_t type,uint32_t a,uint32_t b,uint32_t c) {
  uint32_t irq=save_and_disable_interrupts();
  if(eventCount<512) events[eventCount++]={millis(),type,a,b,c};
  else dropped++;
  restore_interrupts(irq);
}

void diagnosticsBegin() {
  storageReady=LittleFS.begin();
  if(storageReady) {
    LittleFS.remove("/diag-previous.txt");
    if(LittleFS.exists("/diag-current.txt")) LittleFS.rename("/diag-current.txt","/diag-previous.txt");
  }
  input_tool_trace(1,storageReady,0,0);
}

static void snapshot() {
  if(!storageReady) return;
  File file=LittleFS.open("/diag-current.txt","w");
  if(!file) return;
  uint32_t count=eventCount;
  file.printf("INPUT TOOL DIAGNOSTICS events=%lu dropped=%lu\n",(unsigned long)count,(unsigned long)dropped);
  file.println("ms,event,a,b,c (arguments hexadecimal)");
  for(uint32_t i=0;i<count;i++) {
    const Event &e=events[i];
    file.printf("%lu,%lu,%08lx,%08lx,%08lx\n",(unsigned long)e.ms,(unsigned long)e.type,
      (unsigned long)e.a,(unsigned long)e.b,(unsigned long)e.c);
  }
  file.close();
}

void diagnosticsPoll() {
  uint32_t flags=(tud_mounted()?1:0)|(tud_suspended()?2:0)|(tud_ready()?4:0);
  if(flags!=lastFlags){input_tool_trace(3,flags,0,0);lastFlags=flags;}
  // Flash writes mask interrupts briefly; keep them out of initial enumeration.
  if(!savedFirst && millis()>=20000){snapshot();savedFirst=true;}
  if(!savedFinal && millis()>=60000){snapshot();savedFinal=true;}
}

void diagnosticsDump(Print &output) {
  output.println("BEGIN DIAGNOSTICS");
  for(const char *name:{"/diag-previous.txt","/diag-current.txt"}) {
    output.println(name);
    File file=LittleFS.open(name,"r");
    if(file){while(file.available())output.write(file.read());file.close();}
    else output.println("No saved snapshot");
  }
  output.println("END DIAGNOSTICS");
}
