using System.Text.Json;
using System.Windows.Automation;

namespace Cpuse.Windows;

internal sealed partial class Backend
{
    private static void Activate(WindowBinding b)
    {
        if (!Win32.IsWindowVisible(b.Handle)) throw new RpcError("WINDOW_HIDDEN", "Window is hidden.");
        if (Win32.IsHungAppWindow(b.Handle)) throw new RpcError("WINDOW_UNRESPONSIVE", "Window is not responding.");
        if (Win32.IsIconic(b.Handle)) Win32.ShowWindow(b.Handle, 9);
        if (!IsRelated(Win32.GetForegroundWindow(), b.Handle))
        {
            Win32.SetForegroundWindow(b.Handle);
            if (!IsRelated(Win32.GetForegroundWindow(), b.Handle))
            {
                var foregroundThread = Win32.GetWindowThreadProcessId(Win32.GetForegroundWindow(), out _);
                var current = Win32.GetCurrentThreadId();
                var attached = foregroundThread != 0 && foregroundThread != current && Win32.AttachThreadInput(current, foregroundThread, true);
                try { Win32.BringWindowToTop(b.Handle); Win32.SetForegroundWindow(b.Handle); }
                finally { if (attached) Win32.AttachThreadInput(current, foregroundThread, false); }
            }
            for (var i = 0; i < 10 && !IsRelated(Win32.GetForegroundWindow(), b.Handle); i++) Thread.Sleep(30);
        }
        if (!IsRelated(Win32.GetForegroundWindow(), b.Handle)) throw new RpcError("FOCUS_FAILED", "Windows refused to activate the selected window; no input was sent.");
    }
    private static void EnsureForeground(WindowBinding b)
    {
        Win32.RequireDesktop();
        if (!IsRelated(Win32.GetForegroundWindow(), b.Handle)) throw new RpcError("FOCUS_CHANGED", "Foreground window changed before input.");
        var actual = Win32.ProcessIdentity(b.Handle);
        if (actual.Pid != b.Pid || actual.Started != b.Started) throw new RpcError("WINDOW_REPLACED", "Window process identity changed before input.");
        Injection.RequireTarget(b.Handle);
        var foreground = Win32.GetForegroundWindow();
        if (foreground != b.Handle) Injection.RequireTarget(foreground);
    }

    private Win32.POINT Coordinate(WindowBinding b, JsonElement p, string xName, string yName)
    {
        var x = Number(p, xName); var y = Number(p, yName);
        var rect = Win32.Bounds(b.Handle);
        var width = rect.Width; var height = rect.Height;
        if (p.TryGetProperty("screenshotId", out var screenshotId))
        {
            var observation = Fresh(b, p);
            if (!observation.Screenshots.TryGetValue(screenshotId.GetString()!, out var screenshot)) throw new RpcError("STALE_SCREENSHOT", "screenshotId is not cached for this target window.");
            if (!Win32.IsWindow(screenshot.Handle) || !EqualRect(screenshot.Bounds, Win32.Bounds(screenshot.Handle, screenshot.Handle != b.Handle || Capture.WgcSupported)))
            {
                // WGC is bounded by extended frame; PrintWindow uses outer bounds.
                var outer = Win32.Bounds(screenshot.Handle);
                if (!EqualRect(screenshot.Bounds, outer)) throw new RpcError("STALE_SCREENSHOT", "Screenshot window moved or resized.");
            }
            rect = screenshot.Bounds; width = screenshot.Width; height = screenshot.Height;
        }
        if (x < 0 || y < 0 || x >= width || y >= height) throw new RpcError("COORDINATE_OUT_OF_BOUNDS", $"Coordinates must be within {width} × {height}.");
        return new Win32.POINT(rect.Left + (int)Math.Round(x * rect.Width / width), rect.Top + (int)Math.Round(y * rect.Height / height));
    }
    private static void HitTest(WindowBinding b, Win32.POINT point)
    {
        EnsureForeground(b);
        var hit = Win32.WindowFromPoint(point);
        if (hit == 0 || !IsRelated(hit, b.Handle)) throw new RpcError("POINT_OCCLUDED", "Point currently hits a different window; get a fresh observation.");
    }
    private static Win32.INPUT MoveInput(Win32.POINT point)
    {
        var x = Win32.GetSystemMetrics(76); var y = Win32.GetSystemMetrics(77);
        var width = Win32.GetSystemMetrics(78); var height = Win32.GetSystemMetrics(79);
        if (width < 2 || height < 2 || point.X < x || point.X >= x + width || point.Y < y || point.Y >= y + height) throw new RpcError("POINT_OFF_SCREEN", "Point lies outside the virtual desktop.");
        return new Win32.INPUT { Type = 0, Data = new Win32.INPUTUNION { Mouse = new Win32.MOUSEINPUT { Dx = (int)Math.Round((point.X - x) * 65535.0 / (width - 1)), Dy = (int)Math.Round((point.Y - y) * 65535.0 / (height - 1)), Flags = 0x8000 | 0x4000 | 0x2000 | 0x0001 } } };
    }
    private static void Move(Win32.POINT point) => Win32.Send(MoveInput(point));
    private void Click(WindowBinding b, JsonElement p)
    {
        Win32.POINT point;
        if (p.TryGetProperty("element_index", out _))
        {
            if (p.TryGetProperty("x", out _) || p.TryGetProperty("y", out _)) throw new RpcError("INVALID_ARGUMENT", "Choose either element_index or coordinates.");
            var e = Element(b, p);
            if (!e.Current.IsEnabled || e.Current.IsOffscreen) throw new RpcError("ELEMENT_NOT_INTERACTABLE", "Element is disabled or off screen.");
            var bounds = e.Current.BoundingRectangle;
            if (bounds.IsEmpty || bounds.Width <= 0 || bounds.Height <= 0) throw new RpcError("ELEMENT_NOT_INTERACTABLE", "Element has no clickable bounds.");
            point = new Win32.POINT((int)(bounds.X + bounds.Width / 2), (int)(bounds.Y + bounds.Height / 2));
        }
        else point = Coordinate(b, p, "x", "y");
        var count = Int(p, "click_count", 1);
        if (count < 1 || count > 3) throw new RpcError("INVALID_ARGUMENT", "click_count must be 1, 2, or 3.");
        var button = p.TryGetProperty("mouse_button", out var buttonValue) ? buttonValue.GetString() : "left";
        var flags = button?.ToLowerInvariant() switch { "left" or "l" => (2u, 4u), "right" or "r" => (8u, 16u), "middle" or "m" => (32u, 64u), _ => throw new RpcError("INVALID_ARGUMENT", "mouse_button must be left, right, or middle.") };
        Injection.Require("click");
        Injection.RequireTarget(b.Handle);
        Activate(b); HitTest(b, point); Move(point); Injection.VerifyPointer(point);
        for (var i = 0; i < count; i++) { HitTest(b, point); Win32.Send(Win32.Mouse(flags.Item1), Win32.Mouse(flags.Item2)); if (i + 1 < count) Thread.Sleep(55); }
        RecordVerifiedClick(b);
    }
    private void Scroll(WindowBinding b, JsonElement p)
    {
        var point = Coordinate(b, p, "x", "y");
        var dx = Number(p, "scrollX"); var dy = Number(p, "scrollY");
        if (Math.Abs(dx) > 100_000 || Math.Abs(dy) > 100_000) throw new RpcError("INVALID_ARGUMENT", "Scroll deltas exceed 100000 wheel units.");
        Injection.Require("scroll");
        Injection.RequireTarget(b.Handle);
        Activate(b); HitTest(b, point); Move(point); Injection.VerifyPointer(point);
        if (dy != 0) Win32.Send(Win32.Mouse(0x0800, unchecked((uint)-(int)Math.Round(dy))));
        if (dx != 0) Win32.Send(Win32.Mouse(0x1000, unchecked((uint)(int)Math.Round(dx))));
    }
    private void Drag(WindowBinding b, JsonElement p)
    {
        var from = Coordinate(b, p, "from_x", "from_y"); var to = Coordinate(b, p, "to_x", "to_y");
        Injection.Require("drag");
        Injection.RequireTarget(b.Handle);
        Activate(b); HitTest(b, from); HitTest(b, to);
        var inputs = new List<Win32.INPUT> { MoveInput(from), Win32.Mouse(2) };
        for (var i = 1; i <= 24; i++) inputs.Add(MoveInput(new Win32.POINT(from.X + (to.X - from.X) * i / 24, from.Y + (to.Y - from.Y) * i / 24)));
        inputs.Add(Win32.Mouse(4));
        EnsureForeground(b);
        // Paired down/up are submitted atomically to the OS queue: cancellation
        // cannot terminate the backend between separate SendInput calls.
        Win32.Send(inputs.ToArray());
        Injection.VerifyPointer(to);
    }
    private static void EnsureModifiersReleased()
    {
        foreach (var vk in new[] { 0x10, 0x11, 0x12, 0x5B, 0x5C }) if ((Win32.GetAsyncKeyState(vk) & 0x8000) != 0) throw new RpcError("KEYBOARD_BUSY", "A physical modifier is pressed; no keyboard input was sent.");
    }
    private object TypeText(WindowBinding b, JsonElement p)
    {
        var text = String(p, "text");
        if (text.Length == 0 || text.Length > 1_000_000) throw new RpcError("INVALID_ARGUMENT", "Text must contain 1 to one million UTF-16 code units.");
        var method = p.TryGetProperty("method", out var specified) ? specified.GetString() : "unicode";
        if (method is not ("unicode" or "paste")) throw new RpcError("INVALID_ARGUMENT", "type_text method must be unicode or paste.");
        if (method == "paste" && !Bool(p, "allow_clipboard_paste", false)) throw new RpcError("CLIPBOARD_UNAVAILABLE", "Clipboard paste is disabled by the trusted host configuration. No input or clipboard changes were made.");
        Injection.Require("type_text");
        Injection.RequireTarget(b.Handle);
        Activate(b); EnsureModifiersReleased();
        var focused = RequireTextFocus(b);
        var before = ReadFocusedText(focused);
        uint queued = 0;
        var sendAttempted = false;
        ClipboardTransaction? clipboard = null;
        try
        {
            if (method == "paste")
            {
                clipboard = ClipboardTransaction.Begin(text);
                Fresh(b, p); RequireSameTextFocus(b, focused); EnsureModifiersReleased();
                clipboard.RequireCurrent();
                sendAttempted = true;
                queued += Win32.Send(Win32.Key(0x11), Win32.Key(0x56), Win32.Key(0x56, up: true), Win32.Key(0x11, up: true));
            }
            else
            {
                var batch = new List<Win32.INPUT>(516);
                for (var offset = 0; offset < text.Length; offset++)
                {
                    var character = text[offset];
                    if (character is '\r' or '\n')
                    {
                        batch.Add(Win32.Key(0x0D)); batch.Add(Win32.Key(0x0D, up: true));
                        if (character == '\r' && offset + 1 < text.Length && text[offset + 1] == '\n') offset++;
                    }
                    else { batch.Add(Win32.Key(0, scan: character, unicode: true)); batch.Add(Win32.Key(0, up: true, scan: character, unicode: true)); }
                    // Keep a supplementary Unicode character in the same batch.
                    if ((batch.Count >= 512 && !(char.IsHighSurrogate(character) && offset + 1 < text.Length && char.IsLowSurrogate(text[offset + 1]))) || offset + 1 == text.Length)
                    {
                        Fresh(b, p); RequireSameTextFocus(b, focused); EnsureModifiersReleased();
                        sendAttempted = true;
                        queued += Win32.Send(batch.ToArray()); batch.Clear();
                    }
                }
            }
            var changed = false;
            for (var i = 0; i < 12; i++)
            {
                Thread.Sleep(25);
                RequireSameTextFocus(b, focused);
                var current = ReadFocusedText(focused);
                if (before != null && current != null && current != before) { changed = true; break; }
            }
            clipboard?.Restore();
            if (!changed && before != null && !NormalizeNewlines(before).Contains(NormalizeNewlines(text), StringComparison.Ordinal))
                throw new RpcError("INPUT_NOT_ACCEPTED", "Text events were queued once, but the focused provider's readable text did not change within 300 ms. The application may ignore this method or update asynchronously. Stop the text channel and report the uncertain outcome. Observation remains available; a human must decide any explicit UIA replacement. Do not replay through Unicode, paste, another input channel, or changed privileges.");
            return new { receipt = new { method, status = changed ? "text_changed" : "queued_unverified", events_queued = queued, retry_safe = false } };
        }
        catch (Exception error) when (queued > 0 && error is not RpcError { Code: "INPUT_NOT_ACCEPTED" or "INPUT_PARTIAL" or "CLIPBOARD_CHANGED" })
        {
            var cause = error is RpcError rpc ? rpc.Code : error.GetType().Name;
            throw new RpcError("INPUT_OUTCOME_UNKNOWN", $"{queued} text input events were already queued before {cause}. Part or all of the text may have been applied. Do not replay; refresh and inspect the selected window.");
        }
        finally
        {
            try { clipboard?.Dispose(); }
            catch (RpcError error) when (sendAttempted && error.Code != "CLIPBOARD_CHANGED")
            {
                throw new RpcError("INPUT_OUTCOME_UNKNOWN", $"Input submission was attempted and clipboard cleanup failed ({error.Code}). Its delivery count may be partial or unavailable. Paste may have happened and clipboard restoration needs user attention. Do not replay.");
            }
        }
    }
    private static string? ReadFocusedText(FocusSnapshot focus)
    {
        try
        {
            var element = focus.Element;
            if (element == null || element.Current.IsPassword) return null;
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var value)) return ((ValuePattern)value).Current.Value;
            if (element.TryGetCurrentPattern(TextPattern.Pattern, out var text)) return NormalizeNewlines(((TextPattern)text).DocumentRange.GetText(100_000));
        }
        catch (ElementNotAvailableException) { }
        catch (InvalidOperationException) { }
        catch (System.Runtime.InteropServices.COMException) { }
        return null;
    }

    private object PressKey(WindowBinding b, JsonElement p)
    {
        var chord = String(p, "key").Split('+', StringSplitOptions.TrimEntries);
        if (chord.Length == 0 || chord.Length > 8 || chord.Any(string.IsNullOrWhiteSpace)) throw new RpcError("INVALID_KEY", "Use keysym names separated by +; name the + character as plus.");
        Injection.Require("press_key");
        Injection.RequireTarget(b.Handle);
        var mode = p.TryGetProperty("mode", out var specifiedMode) ? specifiedMode.GetString() : "virtual-key";
        if (mode is not ("virtual-key" or "scan-code")) throw new RpcError("INVALID_ARGUMENT", "press_key mode must be virtual-key or scan-code.");
        Activate(b); EnsureModifiersReleased(); EnsureForeground(b);
        var observed = Fresh(b, p);
        var focus = ReadFocus(b, includeUia: false, allowClickedGame: mode == "scan-code");
        if (!focus.InWindow) throw new RpcError("FOCUS_FAILED", "Win32 keyboard focus is not inside the selected window; no key was sent.");
        if (focus.Password == "yes" || observed.KnownPasswordFocus == focus.Handle) throw new RpcError("PASSWORD_INPUT_FORBIDDEN", "A password control has keyboard focus; no key was sent.");
        Injection.RequireTarget(focus.Handle);
        var layout = Win32.GetKeyboardLayout(Win32.GetWindowThreadProcessId(focus.Handle, out _));
        var keys = new List<(ushort Vk, bool Extended)>();
        foreach (var key in chord)
        {
            var resolved = ResolveKey(key, layout);
            foreach (var modifier in resolved.Modifiers)
                if (!keys.Any(x => x.Vk == modifier)) keys.Add((modifier, false));
            if (!keys.Any(x => x.Vk == resolved.Vk)) keys.Add((resolved.Vk, resolved.Extended));
        }
        Win32.INPUT KeyInput((ushort Vk, bool Extended) key, bool up)
        {
            if (mode == "virtual-key") return Win32.Key(key.Vk, up: up, extended: key.Extended);
            var scan = Win32.MapVirtualKeyEx(key.Vk, 4, layout);
            if ((scan & 0xFF) == 0 || (scan & 0xFF00) == 0xE100) throw new RpcError("INVALID_KEY", "This key has no supported single scan code on the target keyboard layout; use virtual-key mode if appropriate.");
            return Win32.Key(0, up: up, scan: (ushort)(scan & 0xFF), extended: (scan & 0xFF00) == 0xE000 || key.Extended, scanCode: true);
        }
        var downs = keys.Select(x => KeyInput(x, false)).ToArray();
        var ups = keys.AsEnumerable().Reverse().Select(x => KeyInput(x, true)).ToArray();
        Fresh(b, p); EnsureForeground(b);
        var now = ReadFocus(b, includeUia: false, allowClickedGame: mode == "scan-code");
        if (!now.InWindow || now.Handle != focus.Handle) throw new RpcError("FOCUS_CHANGED", "Win32 keyboard focus changed before the key chord; no key was sent.");
        var queued = Win32.Send(downs.Concat(ups).ToArray());
        return new { receipt = new { method = mode, status = "queued_unverified", events_queued = queued, retry_safe = false } };
    }

    private static (ushort Vk, bool Extended, ushort[] Modifiers) ResolveKey(string key, nint layout)
    {
        if (System.Text.RegularExpressions.Regex.IsMatch(key, @"^(meta|windows|win|cmd|command|super|os)(_[lr])?$", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            throw new RpcError("SYSTEM_KEY_FORBIDDEN", "Windows/Meta/Super keys are forbidden by the window-scoped input policy.");
        var names = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase)
        {
            ["Control"] = 0x11, ["Ctrl"] = 0x11, ["Control_L"] = 0xA2, ["Control_R"] = 0xA3,
            ["Shift"] = 0x10, ["Shift_L"] = 0xA0, ["Shift_R"] = 0xA1,
            ["Alt"] = 0x12, ["Alt_L"] = 0xA4, ["Alt_R"] = 0xA5,
            ["Meta"] = 0x5B, ["Super"] = 0x5B, ["Super_L"] = 0x5B, ["Super_R"] = 0x5C, ["Win"] = 0x5B,
            ["Return"] = 0x0D, ["Enter"] = 0x0D, ["KP_Enter"] = 0x0D, ["Tab"] = 9, ["space"] = 0x20,
            ["BackSpace"] = 8, ["Escape"] = 0x1B, ["Esc"] = 0x1B, ["Delete"] = 0x2E, ["Insert"] = 0x2D,
            ["Home"] = 0x24, ["End"] = 0x23, ["Page_Up"] = 0x21, ["PageUp"] = 0x21, ["Prior"] = 0x21,
            ["Page_Down"] = 0x22, ["PageDown"] = 0x22, ["Next"] = 0x22,
            ["Left"] = 0x25, ["Up"] = 0x26, ["Right"] = 0x27, ["Down"] = 0x28,
            ["Caps_Lock"] = 0x14, ["Num_Lock"] = 0x90, ["Scroll_Lock"] = 0x91, ["Print"] = 0x2C,
            ["PrintScreen"] = 0x2C, ["Pause"] = 0x13, ["Menu"] = 0x5D,
            ["KP_Add"] = 0x6B, ["Numpad_Add"] = 0x6B, ["KP_Subtract"] = 0x6D, ["Numpad_Subtract"] = 0x6D,
            ["KP_Multiply"] = 0x6A, ["Numpad_Multiply"] = 0x6A, ["KP_Divide"] = 0x6F, ["Numpad_Divide"] = 0x6F,
            ["KP_Decimal"] = 0x6E, ["Numpad_Decimal"] = 0x6E, ["Numpad_Enter"] = 0x0D
        };
        if (names.TryGetValue(key, out var code)) return (code, key.EndsWith("_R", StringComparison.OrdinalIgnoreCase) && code != 0xA1 || code is >= 0x21 and <= 0x2E || key.Equals("KP_Enter", StringComparison.OrdinalIgnoreCase) || key.Equals("Numpad_Enter", StringComparison.OrdinalIgnoreCase) || code == 0x6F, Array.Empty<ushort>());
        if (key.StartsWith("F", StringComparison.OrdinalIgnoreCase) && int.TryParse(key[1..], out var f) && f is >= 1 and <= 24) return ((ushort)(0x70 + f - 1), false, Array.Empty<ushort>());
        var digit = key.StartsWith("KP_", StringComparison.OrdinalIgnoreCase) ? key[3..] : key.StartsWith("Numpad_", StringComparison.OrdinalIgnoreCase) ? key[7..] : "";
        if (digit.Length == 1 && char.IsAsciiDigit(digit[0])) return ((ushort)(0x60 + digit[0] - '0'), false, Array.Empty<ushort>());
        var symbols = new Dictionary<string, char>(StringComparer.OrdinalIgnoreCase) { ["period"] = '.', ["greater"] = '>', ["comma"] = ',', ["less"] = '<', ["slash"] = '/', ["backslash"] = '\\', ["semicolon"] = ';', ["colon"] = ':', ["apostrophe"] = '\'', ["quotedbl"] = '"', ["bracketleft"] = '[', ["bracketright"] = ']', ["braceleft"] = '{', ["braceright"] = '}', ["minus"] = '-', ["underscore"] = '_', ["equal"] = '=', ["plus"] = '+', ["grave"] = '`', ["asciitilde"] = '~', ["exclam"] = '!', ["question"] = '?', ["at"] = '@', ["numbersign"] = '#', ["dollar"] = '$', ["percent"] = '%', ["asciicircum"] = '^', ["ampersand"] = '&', ["asterisk"] = '*', ["parenleft"] = '(', ["parenright"] = ')' };
        var ch = symbols.TryGetValue(key, out var symbol) ? symbol : key.Length == 1 ? key[0] : '\0';
        if (ch == '\0') throw new RpcError("INVALID_KEY", $"Unsupported keysym: {key}");
        var scan = Win32.VkKeyScanEx(ch, layout);
        if (scan == -1) throw new RpcError("INVALID_KEY", $"No key mapping exists for {key}; use type_text for Unicode text.");
        var modifiers = new List<ushort>();
        if ((scan & 0x100) != 0) modifiers.Add(0x10);
        if ((scan & 0x200) != 0) modifiers.Add(0x11);
        if ((scan & 0x400) != 0) modifiers.Add(0x12);
        return ((ushort)(scan & 0xFF), false, modifiers.ToArray());
    }
}
