namespace Cpuse.Windows;

/// <summary>
/// Desktop input injection needs a token that may write the interactive desktop.
/// A sandboxed or low-integrity helper keeps reporting successful SendInput
/// calls while UIPI silently drops every event, which would tell the model an
/// action happened when nothing did. The gate probes the real condition once and
/// refuses input up front; coordinate input is verified again after the move.
/// </summary>
internal static class Injection
{
    private static bool? available;

    /// <summary>
    /// A no-op <c>SetCursorPos</c> to the current position fails exactly when the
    /// desktop refuses this process's input, and changes nothing when it succeeds.
    /// </summary>
    internal static bool Available
    {
        get
        {
            if (available is null)
                available = Win32.GetCursorPos(out var point) && Win32.SetCursorPos(point.X, point.Y);
            return available.Value;
        }
    }

    internal static string Integrity => Win32.IntegrityName();

    internal static string State => Available ? "allowed" : "blocked";

    internal static string Note => Available
        ? "Desktop input injection is available to this helper."
        : $"This helper runs with a {Integrity} integrity token, so Windows drops every injected desktop event (UIPI). Input methods fail with INPUT_BLOCKED instead of reporting success; observation and UIA methods still work. Check the helper's own path too: a Low mandatory integrity label left behind by a file-system sandbox makes that executable launch at Low integrity everywhere.";

    internal static void Require(string method)
    {
        if (Available) return;
        throw new RpcError("INPUT_BLOCKED", $"Cannot inject desktop input for {method}: the native helper runs with a {Integrity} integrity token, so Windows silently drops every SendInput event (UIPI). Either the process is sandboxed, or its own executable carries a Low mandatory integrity label (an elevated `icacls <tree> /setintegritylevel (OI)(CI)Medium /T` clears that residue). Run the helper at medium integrity, or use observation and UIA methods (list_apps, list_windows, get_window, get_window_state, set_value, perform_secondary_action).");
    }

    /// <summary>
    /// Confirms an injected pointer move reached its target; catches dropped input
    /// even when the up-front probe passed. Never retries: the outcome is reported.
    /// </summary>
    internal static void VerifyPointer(Win32.POINT target)
    {
        if (!Win32.GetCursorPos(out var actual)) return;
        if (Math.Abs(actual.X - target.X) <= 2 && Math.Abs(actual.Y - target.Y) <= 2) return;
        throw new RpcError("INPUT_DROPPED", $"Injected pointer movement had no effect: the cursor is at {actual.X},{actual.Y} instead of {target.X},{target.Y}. The desktop refused the input (sandboxed helper, UIPI, or an input-filtering driver); nothing was retried.");
    }
}
