# Native pointer calibration

Owned by the control server. The iPad provides a UIKit calibration surface and
pointer/click telemetry; the worker measures movement and validates six targets.
The input tool remains unaware of coordinates or calibration.

Start the calibration service with `npm run calibration --workspace control_server`.
Start an iPad session, then choose Calibrate Pointer (or Settings > Recalibrate
Pointer). Keep the surface visible and do not manually move the pointer.

Twelve movement magnitudes are measured on both axes. A native profile is saved
only after all six targets pass with maximum error <= 3 UIKit points. Failed
runs preserve the previous profile. Disconnect, Stop, or viewport change cancels
the worker and requests input cancellation; uncertain actions are not replayed.

Profiles are stored as `.state/pointer-<deviceID>-<width>x<height>.json`, with
timestamped measurement records in the same private directory. They are runtime
data, never source-controlled examples. Both services use CONTROL_SERVER_STATE_DIR.

The current gate matches device identity and a validated profile. It does not
automatically detect changes to pointer speed or live orientation. Recalibrate
after changing either. Calibration is not an absolute-position tracker across
apps; UIKit points are not necessarily screenshot pixels.

The former Safari calibration page, anonymous telemetry route, open-loop test
driver, and browser screenshots are retired. Only the native app flow is shipped.
