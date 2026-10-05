using System.Text;
using System.Text.Json;

namespace Cpuse.Windows;

internal sealed class RpcError(string code, string message) : Exception(message) { internal string Code { get; } = code; }

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        Win32.SetProcessDpiAwarenessContext(new nint(-4));
        if (args.Contains("--fixture")) { Fixture.Run(args); return; }
        var backend = new Backend();
        if (args.Contains("--integration-test"))
        {
            try { Console.WriteLine(JsonSerializer.Serialize(Fixture.Test(backend))); }
            catch (Exception ex) { Console.Error.WriteLine(ex); Environment.ExitCode = 1; }
            return;
        }
        if (args.Contains("--self-test"))
        {
            var integrity = Win32.IntegrityDiagnostic();
            Console.WriteLine(JsonSerializer.Serialize(new { ok = true, capabilities = backend.Dispatch("capabilities", default), integrity_detail = integrity.Detail, inputStructBytes = System.Runtime.InteropServices.Marshal.SizeOf<Win32.INPUT>() }));
            return;
        }
        string? line;
        while ((line = Console.ReadLine()) != null)
        {
            object? id = null;
            try
            {
                if (line.Length > 16 * 1024 * 1024) throw new RpcError("REQUEST_TOO_LARGE", "JSONL request exceeds 16 MiB.");
                using var request = JsonDocument.Parse(line);
                var root = request.RootElement;
                if (root.TryGetProperty("id", out var requestId)) id = requestId.Clone();
                var method = root.GetProperty("method").GetString() ?? throw new RpcError("INVALID_REQUEST", "method is required.");
                var parameters = root.TryGetProperty("params", out var p) ? p : default;
                var result = backend.Dispatch(method, parameters);
                Console.WriteLine(JsonSerializer.Serialize(new { id, result }));
            }
            catch (Exception ex)
            {
                var error = ex is RpcError rpc ? new { code = rpc.Code, message = rpc.Message } : new { code = "BACKEND_ERROR", message = ex.Message };
                Console.WriteLine(JsonSerializer.Serialize(new { id, error }));
                Console.Error.WriteLine($"{DateTimeOffset.UtcNow:O} {error.code}: {error.message}");
            }
        }
    }
}
