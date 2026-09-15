# Third-party code and licensing

Original project code is licensed under the [MIT License](LICENSE). Packages
remain private to prevent accidental npm publication; the source can be shared
under that license. Third-party code retains its own licenses and notices.

## Included source

- `input_device/libraries/tusb-ncm/src/ncm_device.c`: TinyUSB NCM implementation,
  MIT license. Copyright notices for Ha Thach, Hardy Griech, Jacob Berg Potter,
  and Peter Lawrence are preserved in the file.
- `input_device/firmware/input_tool/dhserver.c` and `.h`: DHCP implementation derived
  from Sergey Fetisov's source, MIT license; full notices remain in those files.
- `input_device/libraries/tusb-ncm/library.properties`: Arduino-Pico library
  metadata identifying Earle F. Philhower, III. Attribution is intentionally kept.

## Installed dependencies

- `ws` 8.21.3: MIT license, installed by npm from the lockfile; its LICENSE is
  included by the upstream package.
- Arduino-Pico 6.1.0: installed by the firmware setup script. Its core LICENSE
  is LGPL-2.1; bundled SDKs/libraries include additional licenses. Toolchain
  sources/binaries are not included in this source archive. Review that pinned
  distribution's notices and source/relinking requirements before publishing
  prebuilt firmware, not just this project's original-code license.
- Apple SDKs/tooling are installed separately and not redistributed here.

This list describes the current source dependencies, not a completed audit of
every library linked into a firmware binary.
