# App icon

The app icon is an editable [Icon Composer document](ipad_computer_use/app_icon.icon),
with separate input-port and pointer SVG layers. All source filenames use
snake_case. Open the document in Apple's Icon Composer to adjust materials,
colors, and appearance variants.

Both Debug and Release use `app_icon` as their app icon source. Xcode compiles
the layered icon and produces the required iPad icon sizes. Do not add a
competing app icon asset catalog. The broadcast extension includes a flat PNG
of the same icon, registered with CFBundleIconFiles for the screen-broadcast
picker. It does not have a separate Home Screen icon. Regenerate the PNG after
editing the layered icon with `bash ipad_app/scripts/export_broadcast_icon.sh`.

Render Default, Dark, Tinted Light, and Tinted Dark previews:

```sh
bash ipad_app/scripts/preview_icons.sh
```

Previews are written to the ignored `ipad_app/build/icon_previews/` folder.
Rebuild the app after changing the icon:

```sh
bash ipad_app/scripts/build.sh -allowProvisioningUpdates
```

See [Apple's Icon Composer guide](https://developer.apple.com/documentation/Xcode/creating-your-app-icon-using-icon-composer).
