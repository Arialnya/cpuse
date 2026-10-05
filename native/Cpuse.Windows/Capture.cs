using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace Cpuse.Windows;

internal sealed record CapturedImage(byte[] Png, int Width, int Height, Win32.RECT Bounds, string Backend, string? FallbackReason);

internal static class Capture
{
    [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IGraphicsCaptureItemInterop
    {
        [PreserveSig] int CreateForWindow(nint window, in Guid iid, out nint result);
        [PreserveSig] int CreateForMonitor(nint monitor, in Guid iid, out nint result);
    }
    [DllImport("combase.dll", CharSet = CharSet.Unicode)] private static extern int WindowsCreateString(string source, int length, out nint value);
    [DllImport("combase.dll")] private static extern int WindowsDeleteString(nint value);
    [DllImport("combase.dll")] private static extern int RoGetActivationFactory(nint name, in Guid iid, out nint factory);
    [DllImport("d3d11.dll")] private static extern int D3D11CreateDevice(nint adapter, uint driverType, nint software, uint flags, nint levels, uint levelCount, uint sdkVersion, out nint device, out uint level, out nint context);
    [DllImport("d3d11.dll")] private static extern int CreateDirect3D11DeviceFromDXGIDevice(nint dxgi, out nint device);

    internal static bool WgcSupported { get { try { return GraphicsCaptureSession.IsSupported(); } catch { return false; } } }
    internal static CapturedImage Get(nint hwnd, bool allowFallback)
    {
        if (Win32.IsIconic(hwnd)) throw new RpcError("WINDOW_MINIMIZED", "Restore the window before capturing it.");
        if (Win32.IsHungAppWindow(hwnd)) throw new RpcError("WINDOW_UNRESPONSIVE", "Window is not responding; capture was not attempted.");
        try { return Wgc(hwnd).GetAwaiter().GetResult(); }
        catch (Exception ex)
        {
            if (!allowFallback) throw new RpcError("CAPTURE_UNAVAILABLE", $"Windows.Graphics.Capture failed: {ex.Message}");
            try { return PrintWindowCapture(hwnd, ex.Message); }
            catch (Exception fallback)
            {
                throw new RpcError("CAPTURE_UNAVAILABLE", $"Windows.Graphics.Capture failed: {ex.Message}; PrintWindow also failed: {fallback.Message}. Window observation never activates a target or copies desktop/other-application pixels.");
            }
        }
    }

    private static GraphicsCaptureItem CreateItem(nint hwnd)
    {
        const string name = "Windows.Graphics.Capture.GraphicsCaptureItem";
        Marshal.ThrowExceptionForHR(WindowsCreateString(name, name.Length, out var text));
        nint factory = 0, item = 0;
        try
        {
            var interopId = typeof(IGraphicsCaptureItemInterop).GUID;
            Marshal.ThrowExceptionForHR(RoGetActivationFactory(text, interopId, out factory));
            var interop = (IGraphicsCaptureItemInterop)Marshal.GetObjectForIUnknown(factory);
            var itemId = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
            Marshal.ThrowExceptionForHR(interop.CreateForWindow(hwnd, itemId, out item));
            return WinRT.MarshalInspectable<GraphicsCaptureItem>.FromAbi(item);
        }
        finally { if (item != 0) Marshal.Release(item); if (factory != 0) Marshal.Release(factory); WindowsDeleteString(text); }
    }

    private static IDirect3DDevice CreateDevice()
    {
        nint device = 0, context = 0, dxgi = 0, inspectable = 0;
        try
        {
            var hr = D3D11CreateDevice(0, 1, 0, 0x20, 0, 0, 7, out device, out _, out context);
            if (hr < 0) Marshal.ThrowExceptionForHR(D3D11CreateDevice(0, 5, 0, 0x20, 0, 0, 7, out device, out _, out context));
            var iid = new Guid("54EC77FA-1377-44E6-8C32-88FD5F44C84C");
            Marshal.ThrowExceptionForHR(Marshal.QueryInterface(device, ref iid, out dxgi));
            Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out inspectable));
            return WinRT.MarshalInterface<IDirect3DDevice>.FromAbi(inspectable);
        }
        finally
        {
            if (inspectable != 0) Marshal.Release(inspectable);
            if (dxgi != 0) Marshal.Release(dxgi);
            if (context != 0) Marshal.Release(context);
            if (device != 0) Marshal.Release(device);
        }
    }

    private static async Task<CapturedImage> Wgc(nint hwnd)
    {
        if (!WgcSupported) throw new RpcError("WGC_UNSUPPORTED", "This device does not support Windows.Graphics.Capture.");
        var item = CreateItem(hwnd);
        if (item.Size.Width <= 0 || item.Size.Height <= 0) throw new RpcError("CAPTURE_UNAVAILABLE", "Window capture has empty dimensions.");
        using var device = CreateDevice();
        using var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, item.Size);
        using var session = pool.CreateCaptureSession(item);
        session.IsCursorCaptureEnabled = false;
        var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        pool.FrameArrived += (_, _) => ready.TrySetResult();
        session.StartCapture();
        await ready.Task.WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
        using var frame = pool.TryGetNextFrame() ?? throw new RpcError("CAPTURE_UNAVAILABLE", "Capture delivered no frame.");
        if (frame.ContentSize.Width != item.Size.Width || frame.ContentSize.Height != item.Size.Height)
            throw new RpcError("WINDOW_CHANGED", "Window resized during capture; obtain another observation.");
        using var bitmap = await SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface).AsTask().ConfigureAwait(false);
        using var stream = new InMemoryRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream).AsTask().ConfigureAwait(false);
        encoder.SetSoftwareBitmap(bitmap);
        await encoder.FlushAsync().AsTask().ConfigureAwait(false);
        var bytes = new byte[checked((int)stream.Size)];
        using var reader = new DataReader(stream.GetInputStreamAt(0));
        await reader.LoadAsync((uint)bytes.Length).AsTask().ConfigureAwait(false);
        reader.ReadBytes(bytes);
        return new CapturedImage(bytes, bitmap.PixelWidth, bitmap.PixelHeight, Win32.Bounds(hwnd, true), "windows-graphics-capture", null);
    }

    private static CapturedImage PrintWindowCapture(nint hwnd, string reason)
    {
        var rect = Win32.Bounds(hwnd);
        if (rect.Width <= 0 || rect.Height <= 0 || (long)rect.Width * rect.Height > 100_000_000)
            throw new RpcError("CAPTURE_UNAVAILABLE", "Invalid window dimensions.");
        using var bitmap = new Bitmap(rect.Width, rect.Height, PixelFormat.Format32bppArgb);
        using var graphics = Graphics.FromImage(bitmap);
        graphics.Clear(Color.Transparent);
        var dc = graphics.GetHdc();
        bool success;
        try { success = Win32.PrintWindow(hwnd, dc, 2); }
        finally { graphics.ReleaseHdc(dc); }
        if (!success) throw new RpcError("CAPTURE_UNAVAILABLE", $"WGC failed ({reason}); PrintWindow also failed.");
        using var output = new MemoryStream();
        bitmap.Save(output, ImageFormat.Png);
        return new CapturedImage(output.ToArray(), bitmap.Width, bitmap.Height, rect, "print-window", reason);
    }

}
