#include <Keyboard.h>
#include <Mouse.h>
#include <USB.h>
#include <NCMEthernetlwIP.h>
#include <WebServer.h>
#include <tusb.h>
#include "dhserver.h"
#include "Diagnostics.h"
#include "InputProtocol.h"
#include "OnboardLights.h"
#if __has_include("GeneratedSecret.h")
#include "GeneratedSecret.h"
#endif

#ifndef INPUT_DEVICE_SECRET
#error "GeneratedSecret.h missing. Build with input_device/scripts/build.sh so the input-device secret is generated and embedded."
#endif

class InputMouse : public Mouse_ {
public:
  void report(uint8_t buttons, int8_t x = 0, int8_t y = 0, int8_t wheel = 0) {
    _buttons = buttons;
    move(x, y, wheel);
  }
};
InputMouse pointer;

NCMEthernetlwIP ethernet;
WebServer server(80);
dhcp_entry_t leases[4] = {};
dhcp_config_t dhcp = {};
InputRecord inputs[512];
uint8_t pointerButtons = 0;
size_t count = 0, cursor = 0;
bool running = false, held = false;
uint32_t nextAt = 0, startsAt = 0;
uint32_t deadline = 0;
const char *state = "idle";
uint32_t lightErrorAt = 0, lightSuccessAt = 0;
bool lightError = false, lightSuccess = false;
const uint32_t bootPollMs = 5;
const uint32_t bootDebounceMs = 30;
const uint32_t bootClickMs = 15;
bool bootRaw = false, bootStable = false, bootConsumed = false;
bool bootReleasePending = false;
uint32_t bootChangedAt = 0, bootNextPollAt = 0, bootReleaseAt = 0;

void setLight(Light color) {
  static int previous = -1;
  if (previous == int(color)) return;
  previous = int(color);
  // The onboard user LED channels are active-low; no NeoPixel driver is used.
  digitalWrite(PIN_LED_R, color == Light::Red || color == Light::Yellow ? LOW : HIGH);
  digitalWrite(PIN_LED_G, color == Light::Green || color == Light::Yellow || color == Light::Cyan ? LOW : HIGH);
  digitalWrite(PIN_LED_B, color == Light::Blue || color == Light::Cyan ? LOW : HIGH);
}

void updateLight() {
  uint32_t now = millis();
  if (lightError && uint32_t(now - lightErrorAt) >= 1500) lightError = false;
  if (lightSuccess && uint32_t(now - lightSuccessAt) >= 1000) lightSuccess = false;
  setLight(onboardLight(tud_mounted(), tud_suspended(), running,
                       running && int32_t(now - startsAt) < 0, lightError, lightSuccess));
}

void finishKeys() {
  running=false;state="done";
  lightSuccess = true; lightSuccessAt = millis();
}
volatile uint32_t completedReports=0;
extern "C" void tud_hid_report_complete_cb(uint8_t, const uint8_t*, uint16_t) {completedReports++;}

int hexDigit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

void stopKeys() {
  Keyboard.releaseAll();
  pointer.report(0);
  pointerButtons = 0;
  bootReleasePending = false;
  running = held = false;
  state = "stopped";
}

void pollBootClick() {
  uint32_t now = millis();
  if (int32_t(now - bootNextPollAt) < 0) return;
  bootNextPollAt = now + bootPollMs;

  if (bootReleasePending && int32_t(now - bootReleaseAt) >= 0 && tud_hid_ready()) {
    pointer.report(0);
    pointerButtons = 0;
    bootReleasePending = false;
  }

  bool raw = (bool)BOOTSEL;
  if (raw != bootRaw) {
    bootRaw = raw;
    bootChangedAt = now;
  }
  if (uint32_t(now - bootChangedAt) < bootDebounceMs || raw == bootStable) return;

  bootStable = raw;
  if (!bootStable) {
    bootConsumed = false;
    return;
  }

  if (bootConsumed) return;
  bootConsumed = true;
  if (running || held || pointerButtons || !tud_hid_ready()) return;
  pointer.report(MOUSE_LEFT);
  pointerButtons = MOUSE_LEFT;
  bootReleasePending = true;
  bootReleaseAt = now + bootClickMs;
}

void reply(int code, const String &body) {
  if (code >= 400) {lightError = true; lightErrorAt = millis();}
  server.sendHeader("Cache-Control", "no-store");
  server.sendHeader("X-Content-Type-Options", "nosniff");
  server.send(code, "application/json", body);
}

void emptyReply(int code) {
  server.sendHeader("Cache-Control", "no-store");
  server.sendHeader("X-Content-Type-Options", "nosniff");
  server.send(code, "text/plain", "");
}

bool authorized() {
  if (server.header("X-Input-Device-Secret") != INPUT_DEVICE_SECRET) {
    reply(403, "{\"error\":\"Input device secret required.\"}");
    return false;
  }
  return true;
}

void runInput() {
  if (!authorized()) return;
  if (running) {reply(409,"{\"error\":\"A sequence is already running.\"}");return;}
  String hex=server.arg("plain");
  hex.trim();
  if(hex.length()==0 || hex.length()>5120 || hex.length()%10) {
    reply(400,"{\"error\":\"Invalid input records\"}");return;
  }
  for(size_t i=0;i<hex.length();i++) if(hexDigit(hex[i])<0) {reply(400,"{\"error\":\"Invalid input encoding\"}");return;}
  size_t n=hex.length()/10;
  uint8_t *bytes=reinterpret_cast<uint8_t *>(inputs);
  static_assert(sizeof(InputRecord)==5,"Input record layout");
  for(size_t i=0;i<n*5;i++) bytes[i]=hexDigit(hex[i*2])*16+hexDigit(hex[i*2+1]);
  if(!validateInput(inputs,n)) {reply(400,"{\"error\":\"Invalid input records or unreleased button\"}");return;}
  count=n;cursor=0;held=false;running=true;state="queued";
  startsAt=nextAt=millis();
  deadline=millis()+70000;
  emptyReply(202);
}

void setup() {
  for (auto pin : {PIN_LED_R, PIN_LED_G, PIN_LED_B}) {
    digitalWrite(pin, HIGH);
    pinMode(pin, OUTPUT);
  }
  setLight(Light::Yellow);
  diagnosticsBegin();
  Serial.begin(115200);
  Keyboard.begin();
  pointer.begin();
  // No gateway or DNS: the host must keep its existing internet connection.
  ethernet.config(IPAddress(172,31,254,1),IPAddress(0,0,0,0),IPAddress(255,255,255,248),IPAddress(0,0,0,0));
  if (!ethernet.begin()) {setLight(Light::Red);while(true) delay(1000);}
  USB.disconnect();
  for (int i=0;i<4;i++) {
    IP4_ADDR(&leases[i].addr,172,31,254,2+i);
    leases[i].lease=3600;
  }
  dhcp.port=67;dhcp.num_entry=4;dhcp.entries=leases;
  ethernet_arch_lwip_begin();
  err_t err=dhserv_init(&dhcp);
  ethernet_arch_lwip_end();
  if (err!=ERR_OK) {setLight(Light::Red);while(true) delay(1000);}
  server.collectHeaders("X-Input-Device-Secret");
  server.on("/",HTTP_GET,[](){reply(200,"{\"device\":\"XIAO Input Tool\",\"status\":\"/status\",\"input\":\"/input\"}");});
  server.on("/status",HTTP_GET,[](){
    int32_t wait = running ? (int32_t)(startsAt-millis()) : 0;
    reply(200,String("{\"device\":\"XIAO Input Tool\",\"running\":")+(running?"true":"false")+
      ",\"state\":\""+state+"\",\"waitMs\":"+String(wait>0?wait:0)+
      ",\"hidReady\":"+(tud_hid_ready()?"true":"false")+",\"reports\":"+String((uint32_t)completedReports)+"}");
  });
  server.on("/input",HTTP_POST,runInput);
  server.on("/stop",HTTP_POST,[](){if(authorized()){stopKeys();emptyReply(200);}});
  server.onNotFound([](){reply(404,"{\"error\":\"Not found\"}");});
  server.begin();
  USB.connect();
}

void loop() {
  diagnosticsPoll();
  static char serialCommand[16];
  static size_t serialUsed=0;
  if (Serial.available()) {
    while(Serial.available()) {
      char ch=Serial.read();
      if(ch=='\n') {
        serialCommand[serialUsed]=0;
        if(!strcmp(serialCommand,"LOG"))diagnosticsDump(Serial);
        else Serial.printf("INPUT_TOOL mounted=%d connected=%d ip=%s state=%s\n",tud_mounted(),ethernet.connected(),ethernet.localIP().toString().c_str(),state);
        serialUsed=0;
      } else if(ch!='\r' && serialUsed<sizeof(serialCommand)-1)serialCommand[serialUsed++]=ch;
    }
  }
  if (running && (!tud_mounted() || tud_suspended() || (int32_t)(millis()-deadline)>=0)) {
    stopKeys();
    lightError = true; lightErrorAt = millis();
  }
  pollBootClick();
  // Never enter the HTTP parser while a physical key is held.
  if (!held && !pointerButtons) server.handleClient();
  updateLight();
  if (!running || (int32_t)(millis()-nextAt)<0) return;
  if (!tud_hid_ready()) return;
  if (held) {
    Keyboard.releaseAll();held=false;cursor++;nextAt=millis()+15;
    if(cursor==count) finishKeys();
    return;
  }
  if (cursor==count) {finishKeys();return;}
  state="typing";
  const auto &r=inputs[cursor];
  if(r.type==2) {
    pointer.report(r.a,(int8_t)r.b,(int8_t)r.c,(int8_t)r.d);
    pointerButtons=r.a;cursor++;nextAt=millis()+15;return;
  }
  if(r.type==3) {cursor++;nextAt=millis()+(r.a|(uint32_t(r.b)<<8));return;}
  uint8_t m=r.a, key=r.b;
  if(m&1)Keyboard.press(KEY_LEFT_CTRL);
  if(m&2)Keyboard.press(KEY_LEFT_SHIFT);
  if(m&4)Keyboard.press(KEY_LEFT_ALT);
  if(m&8)Keyboard.press(KEY_LEFT_GUI);
  Keyboard.press(key);held=true;nextAt=millis()+15;
}
