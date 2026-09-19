// Helper downloads shown on the landing page.
//
// The installers live beside the published site, in the `helper-app/` folder of the
// dbh-insights.github.io repository, so these are ordinary relative links: the site
// serves the files itself and no GitHub sign-in is needed. That folder is not part of
// `collect/`, so the links only resolve on the published site, not in a local preview.
//
// After building a new helper, copy the installer into `helper-app/` and update the
// version, file name and size below. `size` is shown as-is; keep it roughly right.
// Set `file` to null for a platform with no build yet: the card then says so instead
// of offering a dead link.

const DOWNLOADS = {
  version: "0.3.0",
  folder: "helper-app/",
  platforms: [
    {
      id: "mac",
      name: "macOS",
      note: "Apple silicon · macOS 12 or later",
      file: "DBH Insights Helper_0.3.0_aarch64.dmg",
      kind: "DMG",
      size: "5.5 MB",
      detect: /mac/i,
      tip: "This build isn't signed by Apple. If macOS says the app is damaged, run `xattr -dr com.apple.quarantine \"/Applications/DBH Insights Helper.app\"` once, then open it again.",
    },
    {
      id: "windows",
      name: "Windows",
      note: "64-bit · Windows 10, 11 and Server",
      file: "DBH Insights Helper_0.3.0_x64-setup.exe",
      kind: "Installer",
      size: "3.1 MB",
      detect: /win/i,
      tip: "This build isn't code-signed. Windows shows “Windows protected your PC”; choose More info, then Run anyway.",
    },
    {
      id: "linux",
      name: "Linux",
      note: "64-bit · AppImage or .deb",
      file: null,
      detect: /linux|x11/i,
      tip: "No Linux build yet. The helper is a Tauri app and builds on Linux from source.",
    },
  ],
};
