using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace Cpuse.Windows;

/// <summary>
/// Explicit, short-lived paste transaction. Original clipboard bytes never
/// leave this process. Unsupported handle formats fail before EmptyClipboard.
/// A concurrent clipboard writer always wins; its newer content is not replaced.
/// </summary>
internal sealed class ClipboardTransaction : IDisposable
{
    private const long MaximumSnapshotBytes = 64 * 1024 * 1024;
    private readonly NativeWindow owner = new();
    private readonly List<(uint Format, byte[] Bytes)> original = new();
    private uint sequence;
    private bool finished;

    [DllImport("user32.dll", SetLastError = true)] private static extern bool OpenClipboard(nint owner);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)] private static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)] private static extern uint EnumClipboardFormats(uint format);
    [DllImport("user32.dll", SetLastError = true)] private static extern nint GetClipboardData(uint format);
    [DllImport("user32.dll", SetLastError = true)] private static extern nint SetClipboardData(uint format, nint memory);
    [DllImport("user32.dll")] private static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint RegisterClipboardFormat(string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint GlobalAlloc(uint flags, nuint bytes);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint GlobalLock(nint memory);
    [DllImport("kernel32.dll")] private static extern bool GlobalUnlock(nint memory);
    [DllImport("kernel32.dll")] private static extern nuint GlobalSize(nint memory);
    [DllImport("kernel32.dll")] private static extern nint GlobalFree(nint memory);

    private ClipboardTransaction() => owner.CreateHandle(new CreateParams { Caption = "cpuse-clipboard-transaction", Parent = new nint(-3) });

    internal static ClipboardTransaction Begin(string text)
    {
        if (text.Contains('\0')) throw new RpcError("INVALID_ARGUMENT", "Clipboard Unicode text cannot contain a NUL character.");
        var transaction = new ClipboardTransaction();
        var opened = false;
        var replaced = false;
        try
        {
            if (!OpenClipboard(transaction.owner.Handle)) throw Unavailable("Clipboard is currently held by another process; no input or clipboard changes were made.");
            opened = true;
            transaction.Snapshot();
            var history = RegisterClipboardFormat("CanIncludeInClipboardHistory");
            var cloud = RegisterClipboardFormat("CanUploadToCloudClipboard");
            var monitor = RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing");
            if (history == 0 || cloud == 0 || monitor == 0) throw Unavailable("Cannot register clipboard privacy formats; clipboard was not changed.");
            // Allocate every temporary block before destroying the old contents.
            var temporary = new List<(uint Format, nint Memory)>();
            try
            {
                temporary.Add((13, Allocate(Encoding.Unicode.GetBytes(text + "\0"))));
                temporary.Add((history, Allocate(new byte[4])));
                temporary.Add((cloud, Allocate(new byte[4])));
                temporary.Add((monitor, Allocate(new byte[] { 1 })));
                if (!EmptyClipboard()) throw Unavailable("Clipboard could not be emptied; no key was sent.");
                replaced = true;
                for (var i = 0; i < temporary.Count; i++)
                {
                    var item = temporary[i];
                    if (SetClipboardData(item.Format, item.Memory) == 0) throw Unavailable("Cannot set temporary clipboard data; no key was sent.");
                    temporary[i] = (item.Format, 0); // Windows owns transferred handles.
                }
            }
            finally { foreach (var item in temporary) if (item.Memory != 0) GlobalFree(item.Memory); }
            transaction.sequence = GetClipboardSequenceNumber();
            return transaction;
        }
        catch
        {
            try { if (replaced) transaction.WriteOriginal(); }
            finally
            {
                transaction.finished = true;
                transaction.ClearSnapshot();
                transaction.owner.DestroyHandle();
            }
            throw;
        }
        finally { if (opened) CloseClipboard(); }
    }

    private void Snapshot()
    {
        long total = 0;
        uint format = 0;
        while (true)
        {
            Marshal.SetLastPInvokeError(0);
            format = EnumClipboardFormats(format);
            if (format == 0)
            {
                if (Marshal.GetLastWin32Error() != 0) throw Unavailable("Cannot enumerate every original clipboard format; clipboard was not changed.");
                break;
            }
            if (format is 2 or 3 or 9 or 14 or 0x0080 or 0x0082 or 0x0083 or 0x008E || format is >= 0x0200 and <= 0x02FF)
                throw Unavailable("Original clipboard contains a bitmap, palette, metafile, owner-display, or private handle format that cannot be losslessly restored. Use Unicode typing or UIA Set Value; clipboard was not changed.");
            var memory = GetClipboardData(format);
            var size = memory == 0 ? 0 : GlobalSize(memory);
            if (memory == 0 || size == 0 || size > (nuint)MaximumSnapshotBytes || total + (long)size > MaximumSnapshotBytes)
                throw Unavailable("Original clipboard contains an unavailable/non-memory format or exceeds the 64 MiB snapshot limit; clipboard was not changed.");
            var pointer = GlobalLock(memory);
            if (pointer == 0) throw Unavailable("Cannot copy an original clipboard format; clipboard was not changed.");
            try
            {
                var bytes = new byte[(int)size];
                Marshal.Copy(pointer, bytes, 0, bytes.Length);
                original.Add((format, bytes)); total += bytes.Length;
            }
            finally { GlobalUnlock(memory); }
        }
    }

    private static nint Allocate(byte[] bytes)
    {
        var memory = GlobalAlloc(0x0002, (nuint)bytes.Length);
        if (memory == 0) throw Unavailable("Cannot allocate clipboard transaction memory.");
        var pointer = GlobalLock(memory);
        if (pointer == 0) { GlobalFree(memory); throw Unavailable("Cannot lock clipboard transaction memory."); }
        try { Marshal.Copy(bytes, 0, pointer, bytes.Length); }
        finally { GlobalUnlock(memory); }
        return memory;
    }

    internal void RequireCurrent()
    {
        if (GetClipboardSequenceNumber() != sequence)
            throw new RpcError("CLIPBOARD_CHANGED", "Another actor changed the clipboard during the paste transaction. Newer clipboard data was preserved; no paste was retried. Inspect the window before deciding what remains.");
    }

    internal void Restore()
    {
        if (finished) return;
        // Check again while holding the clipboard, closing the check/write race.
        if (!OpenClipboard(owner.Handle)) throw Unavailable("Paste may have happened, but the clipboard is locked and its original contents could not yet be restored. No input was retried.");
        try
        {
            if (GetClipboardSequenceNumber() != sequence)
            {
                finished = true;
                throw new RpcError("CLIPBOARD_CHANGED", "Another actor changed the clipboard after the single paste attempt. Its newer data was preserved; paste delivery is uncertain. Observe before proceeding and do not replay automatically.");
            }
            WriteOriginal(); finished = true;
        }
        finally { CloseClipboard(); }
    }

    private void WriteOriginal()
    {
        var allocated = new List<(uint Format, nint Memory)>();
        try
        {
            foreach (var item in original) allocated.Add((item.Format, Allocate(item.Bytes)));
            if (!EmptyClipboard()) throw Unavailable("Cannot restore original clipboard contents.");
            for (var i = 0; i < allocated.Count; i++)
            {
                var item = allocated[i];
                if (SetClipboardData(item.Format, item.Memory) == 0) throw Unavailable("An original clipboard format could not be restored; report this clipboard restoration failure to the user.");
                allocated[i] = (item.Format, 0);
            }
        }
        finally { foreach (var item in allocated) if (item.Memory != 0) GlobalFree(item.Memory); }
    }

    private void ClearSnapshot() { foreach (var item in original) Array.Clear(item.Bytes); original.Clear(); }
    private static RpcError Unavailable(string message) => new("CLIPBOARD_UNAVAILABLE", message);

    public void Dispose()
    {
        try { if (!finished) Restore(); }
        finally { ClearSnapshot(); owner.DestroyHandle(); }
    }
}
