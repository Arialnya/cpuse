namespace Cpuse.Windows;

/// <summary>
/// Desktop access and UIPI are separate checks. Cursor access cannot establish
/// whether a particular target may receive input from this process's token.
/// </summary>
internal static class Injection
{
    /// <summary>
    /// A no-op cursor move checks window-station access only. It is neither an
    /// application acceptance test nor a UIPI test, and is not cached indefinitely.
    /// </summary>
    internal static bool Available
    {
        get
        {
            return Win32.GetCursorPos(out var point) && Win32.SetCursorPos(point.X, point.Y);
        }
    }

    internal static string Integrity => Win32.IntegrityName();

    internal static string State => Available ? "target-dependent" : "blocked";

    internal static string Note => Available
        ? "Window-station cursor access is available. Every selected target is separately checked for UIPI; queued input still requires a refreshed observation to confirm the application handled it."
        : $"The helper ({Integrity} integrity) cannot access the current desktop cursor. Input is unavailable; no privileges or executable security labels are changed by this plugin.";

    internal static void Require(string method)
    {
        if (Available) return;
        throw new RpcError("INPUT_BLOCKED", $"Cannot access the current desktop for {method}. The helper has {Integrity} integrity; the cursor access test alone cannot identify UIPI. Stop input attempts, report the limitation, and continue observation if useful. Do not change privileges, ACLs, integrity labels, or use another input channel.");
    }

    internal static (string Status, string? Reason, string Helper, string Target) TargetState(nint hwnd)
    {
        var helper = Win32.ProcessIntegrity(Win32.GetCurrentProcess());
        var target = Win32.WindowIntegrity(hwnd);
        if (helper.Rid is null || target.Rid is null)
            return ("unknown", "Cannot read helper/target mandatory integrity; input is refused before sending events.", helper.Name, target.Name);
        if (helper.Rid < target.Rid)
            return ("blocked", "The selected target has a higher mandatory integrity level; UIPI prevents input. Report this to the user; do not elevate or bypass the plugin.", helper.Name, target.Name);
        return ("allowed", null, helper.Name, target.Name);
    }

    internal static void RequireTarget(nint hwnd)
    {
        var state = TargetState(hwnd);
        if (state.Status == "unknown") throw new RpcError("INPUT_IDENTITY_UNAVAILABLE", state.Reason!);
        if (state.Status == "blocked") throw new RpcError("INPUT_TARGET_BLOCKED", $"{state.Reason} Helper={state.Helper}, target={state.Target}. No input was sent.");
    }

    /// <summary>
    /// Confirms an injected pointer move reached its target; catches dropped input
    /// even when the up-front probe passed. Never retries: the outcome is reported.
    /// </summary>
    internal static void VerifyPointer(Win32.POINT target)
    {
        if (!Win32.GetCursorPos(out var actual)) throw new RpcError("INPUT_OUTCOME_UNKNOWN", "Pointer events were queued but the resulting cursor cannot be read. Observe before deciding what remains; nothing was retried.");
        if (Math.Abs(actual.X - target.X) <= 2 && Math.Abs(actual.Y - target.Y) <= 2) return;
        throw new RpcError("INPUT_DROPPED", $"Queued pointer movement did not reach the requested point: the cursor is at {actual.X},{actual.Y} instead of {target.X},{target.Y}. Clipping, input filtering, or another actor may have changed it; UIPI is not established by this result. Nothing was retried.");
    }
}
