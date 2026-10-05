using System.Runtime.InteropServices;
using System.Windows.Automation;

namespace Cpuse.Windows;

internal sealed record FocusSnapshot(nint Handle, string Source, string Password, AutomationElement? Element, bool InWindow, bool MenuActive)
{
    internal bool CanType => InWindow && !MenuActive && Password == "no";
}
internal sealed record VerifiedClick(uint Pid, long Started, nint Foreground, Win32.RECT Bounds, DateTimeOffset Time);

internal sealed partial class Backend
{
    // GetGUIThreadInfo reads the target's actual GUI queue, unlike GetFocus,
    // which only reads the helper's own queue. No thread input is attached here.
    private FocusSnapshot ReadFocus(WindowBinding binding, bool includeUia = true, bool allowClickedGame = false)
    {
        var foreground = Win32.GetForegroundWindow();
        var clickCurrent = HasVerifiedClick(binding, foreground);
        var foregroundMatches = foreground != 0 && IsRelated(foreground, binding.Handle);
        var thread = Win32.GetWindowThreadProcessId(foregroundMatches ? foreground : binding.Handle, out _);
        var gui = new Win32.GUITHREADINFO { Size = (uint)Marshal.SizeOf<Win32.GUITHREADINFO>() };
        var hasGui = thread != 0 && Win32.GetGUIThreadInfo(thread, ref gui);
        var handle = hasGui ? gui.Focus : 0;
        var inWindow = foregroundMatches && handle != 0 && Win32.IsWindow(handle) && IsRelated(handle, binding.Handle);
        var menuActive = hasGui && (gui.Flags & (0x02u | 0x04u | 0x08u | 0x10u)) != 0;
        // Some self-drawn games keep only an active GUI queue, not a focus HWND.
        // Only a recent, hit-tested click may bind that queue for scan-code keys.
        // It never establishes an editable/password-safe text target.
        if (allowClickedGame && foregroundMatches && hasGui && handle == 0 && !menuActive && gui.Active != 0 && IsRelated(gui.Active, binding.Handle) && clickCurrent)
        {
            handle = gui.Active; inWindow = true;
        }
        AutomationElement? focused = null;
        try
        {
            var candidate = includeUia ? AutomationElement.FocusedElement : null;
            if (candidate != null && BelongsTo(candidate, binding.Handle)) focused = candidate;
        }
        catch (ElementNotAvailableException) { }
        catch (InvalidOperationException) { }
        catch (COMException) { }

        var password = "unknown";
        var source = inWindow ? "win32" : "none";
        if (focused != null && inWindow)
        {
            try { password = focused.Current.IsPassword ? "yes" : "no"; source = "uia"; }
            catch (ElementNotAvailableException) { focused = null; }
            catch (InvalidOperationException) { focused = null; }
            catch (COMException) { focused = null; }
        }
        if (inWindow && IsNativeEditClass(Win32.ClassName(handle)))
        {
            var stylePassword = (Win32.GetWindowStyle(handle, -16) & 0x20) != 0;
            var checkedCharacter = Win32.SendMessageTimeout(handle, 0x00D2, 0, 0, 0x0002, 100, out var character) != 0;
            // Native password evidence always wins over a stale/faulty UIA provider.
            if (stylePassword || checkedCharacter && character != 0) password = "yes";
            else if (checkedCharacter) password = "no";
        }
        return new(handle, source, password, focused, inWindow, menuActive);
    }

    private static bool IsNativeEditClass(string name) => name.Equals("Edit", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase)
        || name.Contains(".EDIT.", StringComparison.OrdinalIgnoreCase)
        || name.Contains(".RichEdit", StringComparison.OrdinalIgnoreCase);

    private FocusSnapshot RequireTextFocus(WindowBinding binding)
    {
        EnsureForeground(binding);
        var focus = ReadFocus(binding);
        if (!focus.InWindow) throw new RpcError("FOCUS_FAILED", "Win32 keyboard focus is not inside the selected window; no text was sent. Activate/click the selected window through the plugin and observe again.");
        if (focus.Password == "yes") throw new RpcError("PASSWORD_INPUT_FORBIDDEN", "The focused UIA/native Edit element is a password control; no text was sent.");
        if (focus.Password != "no") throw new RpcError("FOCUS_UNKNOWN", "The selected custom control has Win32 focus but exposes no reliable password classification. Text is refused; use a visible editable element/UIA Set Value if available. Window-scoped non-text press_key remains available.");
        if (focus.MenuActive) throw new RpcError("FOCUS_FAILED", "The selected window is in a menu loop; literal text was not sent.");
        Injection.RequireTarget(focus.Handle);
        return focus;
    }

    private void RequireSameTextFocus(WindowBinding binding, FocusSnapshot expected)
    {
        var actual = RequireTextFocus(binding);
        if (actual.Handle != expected.Handle || expected.Element != null && actual.Element != null && !Automation.Compare(expected.Element, actual.Element))
            throw new RpcError("FOCUS_CHANGED", "The focused control changed inside the selected window; no further text was sent.");
    }

    private object InputDiagnostics(WindowBinding binding, Observation observation, bool allowClipboardPaste, bool includeUia)
    {
        var target = Injection.TargetState(binding.Handle);
        var focus = ReadFocus(binding, includeUia, allowClickedGame: true);
        if (focus.Password == "yes") observation.KnownPasswordFocus = focus.Handle;
        return new
        {
            injection = target.Status, reason = target.Reason, helper_integrity = target.Helper, target_integrity = target.Target,
            focus = new { source = focus.Source, in_window = focus.InWindow, password = focus.Password, can_type = focus.CanType },
            text_methods = allowClipboardPaste ? new[] { "unicode", "paste" } : new[] { "unicode" }, key_modes = new[] { "virtual-key", "scan-code" }
        };
    }

    private void RecordVerifiedClick(WindowBinding binding)
    {
        var foreground = Win32.GetForegroundWindow();
        if (!IsRelated(foreground, binding.Handle)) { verifiedClicks.Remove(binding.Handle.ToInt64()); return; }
        verifiedClicks[binding.Handle.ToInt64()] = new(binding.Pid, binding.Started, foreground, Win32.Bounds(binding.Handle), DateTimeOffset.UtcNow);
    }

    private bool HasVerifiedClick(WindowBinding binding, nint foreground)
    {
        var id = binding.Handle.ToInt64();
        if (!verifiedClicks.TryGetValue(id, out var click)) return false;
        if (click.Pid != binding.Pid || click.Started != binding.Started || click.Foreground != foreground || DateTimeOffset.UtcNow - click.Time > TimeSpan.FromSeconds(30) || !EqualRect(click.Bounds, Win32.Bounds(binding.Handle)))
        {
            verifiedClicks.Remove(id); return false;
        }
        return true; // Keys never renew this click's expiry.
    }
}
