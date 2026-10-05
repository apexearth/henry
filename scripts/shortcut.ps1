# Windows: a Start-menu shortcut that runs Henry as one window (scripts/henry.vbs, no console).
# It carries the AppUserModelID the shell sets on itself (src-tauri/src/main.rs), which is what
# lets the taskbar treat the shortcut and the window as one app: one icon, and "Pin to taskbar"
# on the running window pins this shortcut. Also refreshes a taskbar pin of the same name, since
# pinning copies the .lnk and a copy made before this keeps its old target.
#   powershell -ExecutionPolicy Bypass -File scripts\shortcut.ps1
$ErrorActionPreference = "Stop"
$appId = "dev.apexearth.henry"
$repo = Split-Path -Parent $PSScriptRoot
$name = "Henry (dev).lnk"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
  int GetCount(out uint count);
  int GetAt(uint i, out PropertyKey key);
  int GetValue(ref PropertyKey key, out PropVariant value);
  int SetValue(ref PropertyKey key, ref PropVariant value);
  int Commit();
}
[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct PropertyKey { public Guid fmtid; public uint pid; }
[StructLayout(LayoutKind.Explicit)]
public struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
public static class HenryLnk {
  [DllImport("shell32.dll")]
  static extern int SHGetPropertyStoreFromParsingName([MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr bc, int flags, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
  // PKEY_AppUserModel_ID
  static PropertyKey Key() { return new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 }; }
  static IPropertyStore Open(string path, int flags) {
    Guid iid = typeof(IPropertyStore).GUID;
    IPropertyStore store;
    Marshal.ThrowExceptionForHR(SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, flags, ref iid, out store));
    return store;
  }
  public static void SetAppId(string path, string id) {
    IPropertyStore store = Open(path, 2); // GPS_READWRITE
    PropertyKey key = Key();
    PropVariant v = new PropVariant { vt = 31, p = Marshal.StringToCoTaskMemUni(id) }; // VT_LPWSTR
    try {
      Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref v));
      Marshal.ThrowExceptionForHR(store.Commit());
    } finally {
      Marshal.FreeCoTaskMem(v.p);
      Marshal.ReleaseComObject(store);
    }
  }
}
"@

$shell = New-Object -ComObject WScript.Shell
$explorer = New-Object -ComObject Shell.Application
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$name"
$pinned = Join-Path $env:APPDATA "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\$name"
$icon = Join-Path $repo "packages\shell\src-tauri\target\debug\henry-shell.exe"
if (-not (Test-Path $icon)) { $icon = Join-Path $env:USERPROFILE ".bun\bin\bun.exe" }

foreach ($path in @($startMenu, $pinned)) {
  if ($path -eq $pinned -and -not (Test-Path $pinned)) { continue }
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = Join-Path $env:SystemRoot "System32\wscript.exe"
  $lnk.Arguments = '"' + (Join-Path $repo "scripts\henry.vbs") + '"'
  $lnk.WorkingDirectory = $repo
  $lnk.IconLocation = "$icon,0"
  $lnk.Description = "Henry: daemon, Vite and the window, with no console"
  $lnk.Save()
  [HenryLnk]::SetAppId($path, $appId)
  $item = $explorer.Namespace((Split-Path $path)).ParseName((Split-Path $path -Leaf))
  "{0}  (AppUserModelID {1})" -f $path, $item.ExtendedProperty("System.AppUserModel.ID")
}
