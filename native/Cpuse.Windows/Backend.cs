using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Automation;
using Microsoft.Win32;

namespace Cpuse.Windows;

internal sealed record TargetWindow(long id, string app, string? title, string process_name = "", string class_name = "", bool is_minimized = false, bool is_foreground = false);
internal sealed record WindowBinding(nint Handle, uint Pid, long Started, string App);
internal sealed record CachedScreenshot(string Id, nint Handle, Win32.RECT Bounds, int Width, int Height);
internal sealed class Observation
{
    internal required string Id { get; init; }
    internal required DateTimeOffset Time { get; init; }
    internal required Win32.RECT Bounds { get; init; }
    internal Dictionary<int, AutomationElement> Elements { get; } = new();
    internal Dictionary<string, CachedScreenshot> Screenshots { get; } = new();
    internal nint KnownPasswordFocus { get; set; }
}

internal sealed partial class Backend
{
    private readonly Dictionary<long, WindowBinding> bindings = new();
    private readonly Dictionary<long, Observation> observations = new();
    private readonly Dictionary<long, VerifiedClick> verifiedClicks = new();
    private readonly Dictionary<string, string> launchable = new(StringComparer.OrdinalIgnoreCase);
    private const int MaxElements = 1500;
    private readonly TimeSpan maximumAge = TimeSpan.FromSeconds(120);

    internal object? Dispatch(string method, JsonElement p) => method switch
    {
        "capabilities" => new { target = "windows", api_version = 1, coordinate_space = "physical-pixels", dpi_aware = Win32.DpiAware, screenshot_backend = Capture.WgcSupported ? "windows-graphics-capture" : "unavailable", screenshot_fallback = "print-window (opt-in)", process_integrity = Injection.Integrity, input_injection = Injection.State, input_injection_note = Injection.Note, observation_max_age_seconds = maximumAge.TotalSeconds, methods = new[] { "list_apps", "list_windows", "get_window", "launch_app", "get_window_state", "click", "press_key", "type_text", "scroll", "set_value", "drag", "perform_secondary_action", "activate_window", "capabilities" }, limitations = new[] { "Interactive unlocked Windows desktop required", "UIPI blocks input injection from a sandboxed or low-integrity helper", "Protected content and minimized windows may reject capture", "Accessibility depends on each application's UI Automation provider", "PrintWindow fallback is opt-in and may be incomplete for GPU applications", "Coordinate input activates and hit-tests the selected window", "No Codex private browser or native helper is required" } },
        "list_windows" => ListWindows(),
        "list_apps" => ListApps(),
        "get_window" => GetWindow(p),
        "launch_app" => LaunchApp(p),
        "get_window_state" => GetWindowState(p),
        "activate_window" => Act(p, b => Activate(b), false),
        "click" => Act(p, b => Click(b, p)),
        "press_key" => ActResult(p, b => PressKey(b, p)),
        "type_text" => ActResult(p, b => TypeText(b, p)),
        "scroll" => Act(p, b => Scroll(b, p)),
        "set_value" => Act(p, b => SetValue(b, p)),
        "drag" => Act(p, b => Drag(b, p)),
        "perform_secondary_action" => Act(p, b => SecondaryAction(b, p)),
        _ => throw new RpcError("METHOD_NOT_FOUND", $"Unknown method: {method}")
    };

    private List<TargetWindow> ListWindows()
    {
        var result = new List<TargetWindow>();
        Win32.EnumWindows((hwnd, _) =>
        {
            if (!Win32.IsWindowVisible(hwnd) || Win32.GetAncestor(hwnd, 2) != hwnd) return true;
            if (Win32.DwmGetWindowAttribute(hwnd, 14, out int cloaked, sizeof(int)) == 0 && cloaked != 0) return true;
            // Untitled fullscreen/game windows are still real, visible windows.
            // Their process path and class provide identity without guessing HWNDs.
            try { var binding = Bind(hwnd); result.Add(ToWindow(binding)); }
            catch (RpcError) { /* Inaccessible processes cannot be safely bound. */ }
            return true;
        }, 0);
        var existing = result.Select(x => x.id).ToHashSet();
        foreach (var id in bindings.Keys.Where(x => !existing.Contains(x) && !Win32.IsWindow(new nint(x))).ToArray()) { bindings.Remove(id); observations.Remove(id); verifiedClicks.Remove(id); }
        return result;
    }

    private WindowBinding Bind(nint hwnd)
    {
        if (!Win32.IsWindow(hwnd)) throw new RpcError("WINDOW_CLOSED", "Window is no longer open.");
        var identity = Win32.ProcessIdentity(hwnd);
        var id = hwnd.ToInt64();
        if (bindings.TryGetValue(id, out var previous) && (previous.Pid != identity.Pid || previous.Started != identity.Started)) { observations.Remove(id); verifiedClicks.Remove(id); }
        var binding = new WindowBinding(hwnd, identity.Pid, identity.Started, identity.App);
        bindings[id] = binding;
        return binding;
    }

    private static TargetWindow ToWindow(WindowBinding b) => new(b.Handle.ToInt64(), b.App, Win32.Title(b.Handle), Path.GetFileNameWithoutExtension(b.App), Win32.ClassName(b.Handle), Win32.IsIconic(b.Handle), IsRelated(Win32.GetForegroundWindow(), b.Handle));
    private WindowBinding Validate(JsonElement window)
    {
        var id = Long(window, "id");
        if (!bindings.TryGetValue(id, out var binding)) throw new RpcError("UNBOUND_WINDOW", "Select the window through list_windows, list_apps, or get_window first.");
        if (!Win32.IsWindow(binding.Handle)) { observations.Remove(id); throw new RpcError("WINDOW_CLOSED", "The selected window has closed."); }
        var actual = Win32.ProcessIdentity(binding.Handle);
        if (actual.Pid != binding.Pid || actual.Started != binding.Started) { bindings.Remove(id); observations.Remove(id); throw new RpcError("WINDOW_REPLACED", "The HWND was reused by another process; select the window again."); }
        if (window.TryGetProperty("app", out var app) && !string.Equals(app.GetString(), binding.App, StringComparison.OrdinalIgnoreCase))
            throw new RpcError("WINDOW_APP_MISMATCH", "Window app identity does not match its bound process.");
        return binding;
    }
    private TargetWindow GetWindow(JsonElement p)
    {
        var hwnd = new nint(Long(p, "id"));
        var b = Bind(hwnd);
        if (p.TryGetProperty("app", out var app) && !string.Equals(app.GetString(), b.App, StringComparison.OrdinalIgnoreCase)) throw new RpcError("WINDOW_APP_MISMATCH", "App does not own this window.");
        return ToWindow(b);
    }

    private List<object> ListApps()
    {
        var windows = ListWindows();
        var result = new Dictionary<string, (string Name, List<TargetWindow> Windows)>(StringComparer.OrdinalIgnoreCase);
        foreach (var w in windows)
        {
            if (!result.TryGetValue(w.app, out var entry)) entry = (Path.GetFileNameWithoutExtension(w.app), new());
            entry.Windows.Add(w); result[w.app] = entry; launchable[w.app] = w.app;
        }
        foreach (var baseKey in new[] { Registry.CurrentUser, Registry.LocalMachine })
        {
            using var apps = baseKey.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths");
            if (apps == null) continue;
            foreach (var name in apps.GetSubKeyNames())
            {
                using var entry = apps.OpenSubKey(name);
                var path = (entry?.GetValue(null) as string)?.Trim('"');
                if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) continue;
                launchable[path] = path;
                result.TryAdd(path, (Path.GetFileNameWithoutExtension(name), new()));
            }
        }
        // AppsFolder includes packaged apps and registered Start Menu applications.
        object? shellObject = null;
        try
        {
            shellObject = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application")!);
            dynamic shell = shellObject!;
            dynamic folder = shell.NameSpace("shell:AppsFolder");
            foreach (dynamic item in folder.Items())
            {
                string path = item.Path; string name = item.Name;
                if (string.IsNullOrWhiteSpace(path)) continue;
                var id = File.Exists(path) ? path : $"shell:{path}";
                launchable[id] = id;
                result.TryAdd(id, (name, new()));
                Marshal.FinalReleaseComObject(item);
            }
        }
        catch (COMException) { /* Registry and running apps remain available if shell catalog is unavailable. */ }
        finally { if (shellObject != null) Marshal.FinalReleaseComObject(shellObject); }
        return result.OrderBy(x => x.Value.Name, StringComparer.OrdinalIgnoreCase).Select(x => (object)new { id = x.Key, displayName = x.Value.Name, isRunning = x.Value.Windows.Count > 0, windows = x.Value.Windows }).ToList();
    }

    private object? LaunchApp(JsonElement p)
    {
        var app = String(p, "app");
        if (app.StartsWith("shell:", StringComparison.OrdinalIgnoreCase))
        {
            if (!launchable.ContainsKey(app)) throw new RpcError("UNKNOWN_APP", "Packaged app must first be discovered through list_apps.");
            Process.Start(new ProcessStartInfo("explorer.exe") { UseShellExecute = true, ArgumentList = { "shell:AppsFolder\\" + app[6..] } });
        }
        else
        {
            if (!app.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) throw new RpcError("INVALID_APP", "An explicit .exe path or discovered app id is required.");
            if (!Path.IsPathRooted(app)) { if (!launchable.TryGetValue(app, out var path)) throw new RpcError("UNKNOWN_APP", "Use a full .exe path or a discovered app id."); app = path; }
            if (!File.Exists(app)) throw new RpcError("APP_NOT_FOUND", "Application executable does not exist.");
            Process.Start(new ProcessStartInfo(app) { UseShellExecute = true });
        }
        return null;
    }

    private object GetWindowState(JsonElement p)
    {
        Win32.RequireDesktop();
        var b = Validate(p.GetProperty("window"));
        var before = Win32.Bounds(b.Handle);
        var observation = new Observation { Id = Guid.NewGuid().ToString("N"), Time = DateTimeOffset.UtcNow, Bounds = before };
        object? accessibility = null;
        if (Bool(p, "include_text", false))
        {
            try { accessibility = ReadAccessibility(b, observation); }
            catch (ElementNotAvailableException) { }
            catch (InvalidOperationException) { }
            catch (COMException) { }
        }
        var screenshots = new List<object>();
        if (Bool(p, "include_screenshot", true))
        {
            var handles = new List<nint> { b.Handle };
            Win32.EnumWindows((candidate, _) =>
            {
                if (candidate != b.Handle && Win32.IsWindowVisible(candidate) && !Win32.IsIconic(candidate) && IsRelated(candidate, b.Handle)) handles.Add(candidate);
                return true;
            }, 0);
            // EnumWindows is front to back. Capture transient UI back to front for zIndex.
            handles = handles.Take(9).ToList();
            var transient = handles.Skip(1).Reverse().ToList();
            handles = new List<nint> { b.Handle }; handles.AddRange(transient);
            foreach (var handle in handles)
            {
                var image = Capture.Get(handle, Bool(p, "allow_print_window_fallback", false));
                var id = Guid.NewGuid().ToString("N");
                observation.Screenshots[id] = new(id, handle, image.Bounds, image.Width, image.Height);
                screenshots.Add(new { id, url = "data:image/png;base64," + Convert.ToBase64String(image.Png), width = image.Width, height = image.Height, originX = image.Bounds.Left, originY = image.Bounds.Top, zIndex = screenshots.Count, capture_backend = image.Backend, fallback_reason = image.FallbackReason, coordinate_space = "physical-pixels" });
            }
        }
        var after = Win32.Bounds(b.Handle);
        if (!EqualRect(before, after)) throw new RpcError("WINDOW_CHANGED", "Window moved or resized while observing it; retry get_window_state.");
        observations[b.Handle.ToInt64()] = observation;
        return new { window = ToWindow(b), observation_id = observation.Id, captured_at = observation.Time.ToString("O"), accessibility, screenshots, input = InputDiagnostics(b, observation, Bool(p, "allow_clipboard_paste", false), Bool(p, "include_text", false)), dpi = Win32.GetDpiForWindow(b.Handle), coordinate_space = "physical-pixels" };
    }

    private object? Act(JsonElement p, Action<WindowBinding> action, bool requiresObservation = true)
    {
        Win32.RequireDesktop();
        var b = Validate(p.GetProperty("window"));
        if (requiresObservation || p.TryGetProperty("observation_id", out _)) Fresh(b, p);
        try { action(b); return null; }
        finally { observations.Remove(b.Handle.ToInt64()); }
    }
    private object? ActResult(JsonElement p, Func<WindowBinding, object> action)
    {
        Win32.RequireDesktop();
        var b = Validate(p.GetProperty("window"));
        Fresh(b, p);
        try { return action(b); }
        finally { observations.Remove(b.Handle.ToInt64()); }
    }
    private Observation Fresh(WindowBinding b, JsonElement p)
    {
        if (!p.TryGetProperty("observation_id", out var requestedId) || requestedId.ValueKind != JsonValueKind.String) throw new RpcError("STALE_OBSERVATION", "Input requires observation_id from the current get_window_state.");
        if (!observations.TryGetValue(b.Handle.ToInt64(), out var o)) throw new RpcError("STALE_OBSERVATION", "Get a new window state before using observation, element, or screenshot references.");
        if (DateTimeOffset.UtcNow - o.Time > maximumAge) throw new RpcError("STALE_OBSERVATION", "Observation expired; get_window_state again.");
        if (requestedId.GetString() != o.Id) throw new RpcError("STALE_OBSERVATION", "observation_id is not the current window state.");
        if (!EqualRect(o.Bounds, Win32.Bounds(b.Handle))) throw new RpcError("STALE_OBSERVATION", "Window geometry changed after observation.");
        return o;
    }
    private AutomationElement Element(WindowBinding b, JsonElement p)
    {
        var o = Fresh(b, p);
        if (!o.Elements.TryGetValue(Int(p, "element_index"), out var element)) throw new RpcError("UNKNOWN_ELEMENT", "Element index is not in the current window accessibility state.");
        try { if (!BelongsTo(element, b.Handle)) throw new RpcError("ELEMENT_CHANGED", "Element is no longer part of this window."); }
        catch (ElementNotAvailableException) { throw new RpcError("ELEMENT_CHANGED", "Element no longer exists."); }
        return element;
    }
    private static bool EqualRect(Win32.RECT a, Win32.RECT b) => a.Left == b.Left && a.Top == b.Top && a.Right == b.Right && a.Bottom == b.Bottom;
    private static string String(JsonElement p, string name) => p.GetProperty(name).GetString() ?? throw new RpcError("INVALID_ARGUMENT", $"{name} must be a string.");
    private static int Int(JsonElement p, string name, int? fallback = null) => p.TryGetProperty(name, out var value) ? value.GetInt32() : fallback ?? throw new RpcError("INVALID_ARGUMENT", $"{name} is required.");
    private static long Long(JsonElement p, string name) => p.GetProperty(name).GetInt64();
    private static double Number(JsonElement p, string name) { var value = p.GetProperty(name).GetDouble(); if (!double.IsFinite(value)) throw new RpcError("INVALID_ARGUMENT", $"{name} must be finite."); return value; }
    private static bool Bool(JsonElement p, string name, bool fallback) => p.TryGetProperty(name, out var value) ? value.GetBoolean() : fallback;
    private static bool IsRelated(nint candidate, nint target)
    {
        if (candidate == target || Win32.GetAncestor(candidate, 2) == target) return true;
        var current = candidate;
        for (var i = 0; i < 30 && current != 0; i++) { current = Win32.GetWindow(current, 4); if (current == target) return true; }
        return false;
    }
    private static bool BelongsTo(AutomationElement element, nint target)
    {
        for (var i = 0; i < 60 && element != null; i++)
        {
            var handle = element.Current.NativeWindowHandle;
            if (handle != 0 && IsRelated(new nint(handle), target)) return true;
            element = TreeWalker.RawViewWalker.GetParent(element);
        }
        return false;
    }
}
