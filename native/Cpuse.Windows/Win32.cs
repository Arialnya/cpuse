using System.Runtime.InteropServices;
using System.Text;

namespace Cpuse.Windows;

internal static class Win32
{
    internal delegate bool EnumWindowsProc(nint hwnd, nint param);
    [StructLayout(LayoutKind.Sequential)] internal struct RECT { public int Left, Top, Right, Bottom; public int Width => Right - Left; public int Height => Bottom - Top; }
    [StructLayout(LayoutKind.Sequential)] internal struct POINT { public int X, Y; public POINT(int x, int y) { X = x; Y = y; } }
    [StructLayout(LayoutKind.Sequential)] internal struct FILETIME { public uint Low, High; public long Value => ((long)High << 32) | Low; }
    [StructLayout(LayoutKind.Sequential)] internal struct INPUT { public uint Type; public INPUTUNION Data; }
    [StructLayout(LayoutKind.Explicit)] internal struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT Mouse; [FieldOffset(0)] public KEYBDINPUT Keyboard; }
    [StructLayout(LayoutKind.Sequential)] internal struct MOUSEINPUT { public int Dx, Dy; public uint MouseData, Flags, Time; public nuint ExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] internal struct KEYBDINPUT { public ushort Vk, Scan; public uint Flags, Time; public nuint ExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] internal struct GUITHREADINFO { public uint Size, Flags; public nint Active, Focus, Capture, MenuOwner, MoveSize, Caret; public RECT CaretBounds; }
    [DllImport("user32.dll")] internal static extern bool EnumWindows(EnumWindowsProc callback, nint param);
    [DllImport("user32.dll")] internal static extern bool IsWindow(nint hwnd);
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(nint hwnd);
    [DllImport("user32.dll")] internal static extern bool IsIconic(nint hwnd);
    [DllImport("user32.dll")] internal static extern bool IsHungAppWindow(nint hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetWindowText(nint hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] internal static extern int GetWindowTextLength(nint hwnd);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(nint hwnd, out uint pid);
    [DllImport("user32.dll")] internal static extern bool GetWindowRect(nint hwnd, out RECT rect);
    [DllImport("user32.dll")] internal static extern nint GetAncestor(nint hwnd, uint flags);
    [DllImport("user32.dll")] internal static extern nint GetWindow(nint hwnd, uint command);
    [DllImport("user32.dll")] internal static extern nint WindowFromPoint(POINT point);
    [DllImport("user32.dll")] internal static extern bool ShowWindow(nint hwnd, int command);
    [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(nint hwnd);
    [DllImport("user32.dll")] internal static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] internal static extern nint SetFocus(nint hwnd);
    [DllImport("user32.dll", SetLastError = true)] internal static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetClassName(nint hwnd, StringBuilder name, int count);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] internal static extern int GetWindowStyle(nint hwnd, int index);
    [DllImport("user32.dll", SetLastError = true)] internal static extern nint SendMessageTimeout(nint hwnd, uint message, nuint wParam, nint lParam, uint flags, uint timeout, out nuint result);
    [DllImport("user32.dll")] internal static extern nint GetKeyboardLayout(uint thread);
    [DllImport("user32.dll")] internal static extern uint MapVirtualKeyEx(uint code, uint type, nint layout);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern short VkKeyScanEx(char ch, nint layout);
    [DllImport("user32.dll")] internal static extern bool BringWindowToTop(nint hwnd);
    [DllImport("user32.dll")] internal static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("user32.dll")] internal static extern bool SetProcessDpiAwarenessContext(nint value);
    [DllImport("user32.dll")] internal static extern nint GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] internal static extern bool AreDpiAwarenessContextsEqual(nint first, nint second);
    [DllImport("user32.dll", SetLastError = true)] private static extern nint OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(nint desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetUserObjectInformation(nint handle, int index, StringBuilder value, int length, out int needed);
    [DllImport("user32.dll")] internal static extern uint GetDpiForWindow(nint hwnd);
    [DllImport("user32.dll")] internal static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll", SetLastError = true)] internal static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll", SetLastError = true)] internal static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] internal static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] internal static extern short VkKeyScan(char ch);
    [DllImport("user32.dll")] internal static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll")] internal static extern bool PrintWindow(nint hwnd, nint hdc, uint flags);
    [DllImport("dwmapi.dll")] internal static extern int DwmGetWindowAttribute(nint hwnd, uint attribute, out RECT rect, int size);
    [DllImport("dwmapi.dll")] internal static extern int DwmGetWindowAttribute(nint hwnd, uint attribute, out int result, int size);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern nint OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] internal static extern bool QueryFullProcessImageName(nint process, uint flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll")] internal static extern bool GetProcessTimes(nint process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);
    [DllImport("kernel32.dll")] internal static extern bool CloseHandle(nint handle);
    [DllImport("kernel32.dll")] internal static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] internal static extern nint GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool OpenProcessToken(nint process, uint access, out nint token);
    [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool GetTokenInformation(nint token, int infoClass, nint info, int length, out int returned);
    [DllImport("advapi32.dll")] internal static extern nint GetSidSubAuthority(nint sid, uint index);
    [DllImport("advapi32.dll")] internal static extern nint GetSidSubAuthorityCount(nint sid);

    /// <summary>Mandatory integrity label of this process, read from its own token.</summary>
    internal static string IntegrityName() => IntegrityDiagnostic().Name;

    /// <summary>Step-by-step token read, so an unexpected sandbox token reports why instead of guessing.</summary>
    internal static (string Name, string Detail) IntegrityDiagnostic()
    {
        var integrity = ProcessIntegrity(GetCurrentProcess());
        return (integrity.Name, integrity.Detail);
    }

    internal static (int? Rid, string Name, string Detail) WindowIntegrity(nint hwnd)
    {
        GetWindowThreadProcessId(hwnd, out var pid);
        var process = OpenProcess(0x1000, false, pid);
        if (process == 0) return (null, "unknown", $"OpenProcess({pid}) failed with {Marshal.GetLastWin32Error()}");
        try { return ProcessIntegrity(process); }
        finally { CloseHandle(process); }
    }

    internal static (int? Rid, string Name, string Detail) ProcessIntegrity(nint process)
    {
        if (!OpenProcessToken(process, 0x0008, out var token))
            return (null, "unknown", $"OpenProcessToken failed with {Marshal.GetLastWin32Error()}");
        try
        {
            var probed = GetTokenInformation(token, 25, 0, 0, out var length);
            if (length <= 0)
                return (null, "unknown", probed ? "GetTokenInformation(TokenIntegrityLevel) reported an empty size" : $"GetTokenInformation size probe failed with {Marshal.GetLastWin32Error()}");
            var buffer = Marshal.AllocHGlobal(length);
            try
            {
                if (!GetTokenInformation(token, 25, buffer, length, out _))
                    return (null, "unknown", $"GetTokenInformation(TokenIntegrityLevel) failed with {Marshal.GetLastWin32Error()}");
                var sid = Marshal.ReadIntPtr(buffer);
                var count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                if (count == 0) return (null, "unknown", "integrity SID has no sub-authority");
                var rid = Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
                return (rid, switchName(rid), $"integrity RID 0x{rid:X}");
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        finally { CloseHandle(token); }
    }

    private static string switchName(int rid) => rid switch
    {
        0x0000 => "untrusted",
        0x1000 => "low",
        0x2000 => "medium",
        0x2100 => "medium-plus",
        0x3000 => "high",
        0x4000 => "system",
        0x5000 => "protected",
        _ => $"rid-{rid}",
    };

    internal static string Title(nint hwnd) { var text = new StringBuilder(Math.Max(256, GetWindowTextLength(hwnd) + 1)); GetWindowText(hwnd, text, text.Capacity); return text.ToString(); }
    internal static string ClassName(nint hwnd) { var text = new StringBuilder(256); GetClassName(hwnd, text, text.Capacity); return text.ToString(); }
    internal static bool DpiAware => AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new nint(-4));
    internal static void RequireDesktop()
    {
        var desktop = OpenInputDesktop(0, false, 0x0001);
        if (desktop == 0) throw new RpcError("DESKTOP_LOCKED", "The interactive desktop is locked or inaccessible.");
        try
        {
            var name = new StringBuilder(256);
            if (!GetUserObjectInformation(desktop, 2, name, name.Capacity * sizeof(char), out _) || !name.ToString().Equals("Default", StringComparison.OrdinalIgnoreCase))
                throw new RpcError("DESKTOP_LOCKED", "Only the unlocked Default interactive desktop can be controlled.");
        }
        finally { CloseDesktop(desktop); }
    }
    internal static (uint Pid, long Started, string App) ProcessIdentity(nint hwnd)
    {
        GetWindowThreadProcessId(hwnd, out var pid);
        var handle = OpenProcess(0x1000, false, pid);
        if (handle == 0) throw new RpcError("IDENTITY_UNAVAILABLE", $"Cannot validate process {pid}; access denied or process exited.");
        try
        {
            if (!GetProcessTimes(handle, out var creation, out _, out _, out _)) throw new RpcError("IDENTITY_UNAVAILABLE", "Cannot read process creation time.");
            var path = new StringBuilder(32768); var length = path.Capacity;
            var app = QueryFullProcessImageName(handle, 0, path, ref length) ? path.ToString() : $"pid:{pid}";
            return (pid, creation.Value, app);
        }
        finally { CloseHandle(handle); }
    }
    internal static RECT Bounds(nint hwnd, bool visibleFrame = false)
    {
        if (visibleFrame && DwmGetWindowAttribute(hwnd, 9, out RECT visible, Marshal.SizeOf<RECT>()) == 0) return visible;
        if (!GetWindowRect(hwnd, out var rect)) throw new RpcError("WINDOW_CLOSED", "Window has disappeared.");
        return rect;
    }
    internal static uint Send(params INPUT[] inputs)
    {
        Marshal.SetLastPInvokeError(0);
        var sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
        if (sent == inputs.Length) return sent;
        if (sent > 0) throw new RpcError("INPUT_PARTIAL", $"SendInput queued {sent} of {inputs.Length} events; part of the action may have happened. Do not replay it. Observe the selected window before deciding what remains.");
        throw new RpcError("INPUT_BLOCKED", $"SendInput queued no events (Win32 error {Marshal.GetLastWin32Error()}). Windows does not identify UIPI through this return value; do not change privileges or retry outside the plugin.");
    }
    internal static INPUT Key(ushort vk, bool up = false, ushort scan = 0, bool unicode = false, bool extended = false, bool scanCode = false) => new() { Type = 1, Data = new INPUTUNION { Keyboard = new KEYBDINPUT { Vk = scanCode ? (ushort)0 : vk, Scan = scan, Flags = (up ? 2u : 0u) | (unicode ? 4u : 0u) | (extended ? 1u : 0u) | (scanCode ? 8u : 0u) } } };
    internal static INPUT Mouse(uint flags, uint data = 0) => new() { Type = 0, Data = new INPUTUNION { Mouse = new MOUSEINPUT { Flags = flags, MouseData = data } } };
}
