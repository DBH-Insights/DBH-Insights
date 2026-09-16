# Build the DBH Insights Helper on Windows Server

A copy-and-paste walkthrough that takes a fresh Windows Server to a built `dbh-insights-helper.exe` and a setup installer. Every command is PowerShell.

**You need**

- Windows Server 2022 or 2025, x64, **with Desktop Experience** (Server Core can compile, but can't show the helper's window)
- An administrator account
- Internet access
- About 15 GB free on `C:`
- About 45 minutes, most of it unattended downloads and the first compile

**What you get**

| File | What it is |
|---|---|
| `dbh-insights-helper.exe` | The helper itself. Runs on its own on any machine that has the WebView2 runtime. |
| `DBH Insights Helper_0.3.0_x64-setup.exe` | An installer that adds Start-menu shortcuts and installs WebView2 if it's missing. Hand this one to users. |

---

## 1. Open PowerShell as Administrator

Start menu → type **PowerShell** → right-click **Windows PowerShell** → **Run as administrator**. Then set up the session:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned -Force
$ProgressPreference = 'SilentlyContinue'
New-Item -ItemType Directory -Force -Path C:\BuildTools | Out-Null
Set-Location C:\BuildTools
```

These settings last only for this window. If you open a new PowerShell window later, paste this block again first. (`$ProgressPreference` makes downloads much faster; the execution policy lets `npm` run.)

## 2. Install the Microsoft C++ build tools

Rust uses Microsoft's compiler and linker on Windows. This installs them with the Windows SDK, and takes 10–20 minutes with no output until it finishes.

```powershell
Invoke-WebRequest -Uri https://aka.ms/vs/17/release/vs_BuildTools.exe -OutFile vs_BuildTools.exe
$vs = Start-Process -FilePath .\vs_BuildTools.exe -Wait -PassThru -ArgumentList '--quiet','--wait','--norestart','--nocache','--add','Microsoft.VisualStudio.Workload.VCTools','--includeRecommended'
"Build tools exit code: $($vs.ExitCode)"
```

- `0` means done.
- `3010` means done but Windows wants a restart. Run `Restart-Computer`, sign back in, open PowerShell as Administrator, and repeat step 1 before carrying on.
- Anything else means it failed; run the block again.

## 3. Install Rust

```powershell
Invoke-WebRequest -Uri https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe -OutFile rustup-init.exe
.\rustup-init.exe -y --default-toolchain stable --default-host x86_64-pc-windows-msvc --profile minimal
```

## 4. Install Node.js (current LTS)

This looks up the newest long-term-support release rather than hard-coding a version.

```powershell
$lts = ((Invoke-RestMethod -Uri https://nodejs.org/dist/index.json) | Where-Object { $_.lts } | Select-Object -First 1).version
"Installing Node.js $lts"
Invoke-WebRequest -Uri "https://nodejs.org/dist/$lts/node-$lts-x64.msi" -OutFile node-lts-x64.msi
Start-Process -FilePath msiexec.exe -Wait -ArgumentList '/i','node-lts-x64.msi','/qn','/norestart'
```

## 5. Install Git

```powershell
$gitAsset = (Invoke-RestMethod -Uri https://api.github.com/repos/git-for-windows/git/releases/latest).assets |
    Where-Object { $_.name -match '^Git-[\d.]+-64-bit\.exe$' } | Select-Object -First 1
"Installing $($gitAsset.name)"
Invoke-WebRequest -Uri $gitAsset.browser_download_url -OutFile git-64-bit.exe
Start-Process -FilePath .\git-64-bit.exe -Wait -ArgumentList '/VERYSILENT','/NORESTART','/NOCANCEL','/SP-'
```

## 6. Install the WebView2 runtime

The helper's window is drawn by WebView2. Windows 11 has it built in; Windows Server usually doesn't. It isn't needed to *compile*, only to *run* the helper on this server. If it's already installed, the installer just exits.

```powershell
Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile MicrosoftEdgeWebview2Setup.exe
Start-Process -FilePath .\MicrosoftEdgeWebview2Setup.exe -Wait -ArgumentList '/silent','/install'
```

## 7. Load the new tools into this window and check them

Installers update `PATH` for *new* windows only. This refreshes the current one:

```powershell
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
rustc --version
cargo --version
node --version
npm --version
git --version
```

All five should print a version. If one says *not recognized*, close PowerShell, open a new one as Administrator, repeat step 1, and try again.

## 8. Get the code

```powershell
git clone https://github.com/DBH-Insights/DBH-Insights.git C:\src\DBH-Insights
Set-Location C:\src\DBH-Insights\helper
```

While the repository is private, a **Sign in to GitHub** window appears; sign in with an account that can see the repository. Keep the short `C:\src` path: Rust builds create deeply nested folders, and a short root keeps them clear of Windows' path-length limit.

## 9. Build

```powershell
npm ci
npm run build -- --bundles nsis
```

`npm ci` installs the exact Tauri CLI version in `package-lock.json`. The first build compiles several hundred Rust crates, which takes 5–15 minutes; later builds take about a minute. It ends with lines like:

```
Finished 1 bundle at:
    C:\src\DBH-Insights\helper\src-tauri\target\release\bundle\nsis\DBH Insights Helper_0.3.0_x64-setup.exe
```

`--bundles nsis` builds the setup `.exe` only. To also get an `.msi`, see [Optional: MSI installer](#optional-msi-installer).

## 10. Collect the files

```powershell
New-Item -ItemType Directory -Force -Path C:\Builds | Out-Null
Copy-Item -Path .\src-tauri\target\release\dbh-insights-helper.exe -Destination C:\Builds\
Copy-Item -Path .\src-tauri\target\release\bundle\nsis\*-setup.exe -Destination C:\Builds\
Get-ChildItem -Path C:\Builds | Format-Table Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } }
```

## 11. Try it

```powershell
Start-Process -FilePath C:\Builds\dbh-insights-helper.exe
```

The settings window opens and an icon appears in the notification area. Add a vCenter and click **Save & test**. Passwords are stored in **Windows Credential Manager** under the Windows account that runs the helper.

To confirm it's listening:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8765/status
```

---

## Rebuilding after changes

```powershell
Set-Location C:\src\DBH-Insights
git pull
Set-Location .\helper
npm ci
npm run build -- --bundles nsis
```

Remember to raise `version` in `helper/src-tauri/tauri.conf.json`, `helper/src-tauri/Cargo.toml` and `helper/package.json` for each release; the installer's file name comes from it.

## Optional: run the helper's tests

```powershell
Set-Location C:\src\DBH-Insights\helper
cargo test --manifest-path .\src-tauri\Cargo.toml
```

## Optional: MSI installer

Tauri builds `.msi` files with WiX Toolset v3, which it downloads by itself:

```powershell
Set-Location C:\src\DBH-Insights\helper
npm run build -- --bundles msi
```

The file lands in `src-tauri\target\release\bundle\msi\`. If the build fails at `light.exe`, WiX is missing the VBScript component, which newer Windows releases install on demand. Check for it and add it:

```powershell
Get-WindowsCapability -Online -Name 'VBSCRIPT*'
Get-WindowsCapability -Online -Name 'VBSCRIPT*' | Where-Object State -ne 'Installed' | Add-WindowsCapability -Online
```

## Handing the installer to users

The build is not code-signed, so the first run shows **Windows protected your PC**. Users click **More info → Run anyway**. For a public release, sign both `.exe` files with a code-signing certificate (Tauri reads `bundle.windows.certificateThumbprint` in `tauri.conf.json`), which removes that warning.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `linker 'link.exe' not found` | The C++ build tools are missing or need a restart. Rerun step 2, restart, then step 1 and step 9. |
| `cargo`, `node` or `git` *is not recognized* | Run step 7, or open a new Administrator PowerShell and repeat step 1. |
| `npm.ps1 cannot be loaded because running scripts is disabled` | Repeat step 1; it allows scripts for the current window. |
| `npm ci` complains that the lock file is out of sync | Someone changed `package.json` without updating the lock file. Run `npm install` instead, then build. |
| Build stops at `Downloading https://github.com/...nsis...` | The server can't reach GitHub downloads. Check the proxy or firewall, then rerun step 9. |
| The helper opens with a blank window | WebView2 is missing. Rerun step 6. |
