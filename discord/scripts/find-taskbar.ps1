Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;

public class WinTaskbarFinder {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    public const int GWL_STYLE = -16;
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_APPWINDOW = 0x00040000;
    public const int WS_EX_TOOLWINDOW = 0x00000080;

    public static void FindAll() {
        EnumWindows((hWnd, lParam) => {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            var title = new StringBuilder(256);
            GetWindowText(hWnd, title, 256);
            var cls = new StringBuilder(256);
            GetClassName(hWnd, cls, 256);
            bool visible = IsWindowVisible(hWnd);
            int exStyle = GetWindowLong(hWnd, GWL_EXSTYLE);
            int style = GetWindowLong(hWnd, GWL_STYLE);

            // Print if visible or has a title or class related to Chrome/Chromium
            if (cls.ToString().Contains("Chrome") || cls.ToString().Contains("Widget") || title.Length > 0) {
                try {
                    var proc = System.Diagnostics.Process.GetProcessById((int)pid);
                    if (proc.ProcessName.ToLower().Contains("chrome") || proc.ProcessName.ToLower().Contains("chromium")) {
                        Console.WriteLine("PID: " + pid + " (" + proc.ProcessName + ") | HWND: " + hWnd + " | Vis: " + visible + " | Cls: '" + cls + "' | Title: '" + title + "'");
                    }
                } catch {}
            }
            return true;
        }, IntPtr.Zero);
    }
}
'@

[WinTaskbarFinder]::FindAll()
