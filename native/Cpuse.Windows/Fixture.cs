using System.Diagnostics;
using System.Drawing;
using System.Text.Json;
using System.Windows.Automation;
using System.Windows.Forms;

namespace Cpuse.Windows;

internal static class Fixture
{
    internal static void Run(string[] args)
    {
        Application.EnableVisualStyles();
        var name = args.ElementAtOrDefault(Array.IndexOf(args, "--fixture-name") + 1) ?? "cpuse-fixture";
        var cover = args.Contains("--cover");
        using var form = new Form { Text = name, Width = 600, Height = 440, Left = 250, Top = 150, StartPosition = FormStartPosition.Manual, BackColor = cover ? Color.Magenta : Color.FromArgb(20, 140, 70) };
        if (!cover)
        {
            var edit = new TextBox { Name = "fixture-edit", Text = "initial", Left = 20, Top = 20, Width = 300, AccessibleName = "Fixture editor" };
            var result = new Label { Name = "fixture-result", Text = "idle", Left = 20, Top = 95, Width = 300 };
            var button = new Button { Name = "fixture-button", Text = "Invoke fixture", Left = 20, Top = 55, Width = 150, AccessibleName = "Fixture button" };
            button.Click += (_, _) => result.Text = "invoked";
            var check = new CheckBox { Name = "fixture-toggle", Text = "Fixture toggle", Left = 190, Top = 55, Width = 140, AccessibleName = "Fixture toggle" };
            var document = new RichTextBox { Name = "fixture-document-editor", Text = "Document initial\nSelected line", Left = 350, Top = 20, Width = 210, Height = 130, AccessibleName = "Fixture document editor", AcceptsTab = true };
            var panel = new Panel { Name = "fixture-scroll", Left = 20, Top = 130, Width = 220, Height = 180, AutoScroll = true, AccessibleName = "Fixture scroll" };
            var tall = new Label { Text = "Scroll document\n" + string.Join("\n", Enumerable.Range(1, 30)), Width = 180, Height = 650, AccessibleName = "Fixture document" };
            panel.Controls.Add(tall);
            var box = new Panel { Name = "fixture-drag", BackColor = Color.Cyan, Left = 350, Top = 180, Width = 60, Height = 60, AccessibleName = "Fixture draggable" };
            Point? origin = null;
            box.MouseDown += (_, e) => { origin = e.Location; box.Capture = true; };
            box.MouseMove += (_, e) => { if (origin is Point start && e.Button == MouseButtons.Left) { box.Left += e.X - start.X; box.Top += e.Y - start.Y; } };
            box.MouseUp += (_, _) => { origin = null; box.Capture = false; result.Text = "dragged"; };
            form.Controls.AddRange(new Control[] { edit, button, check, result, panel, box, document });
            form.Shown += (_, _) => edit.Focus();
        }
        Application.Run(form);
    }

    private static JsonElement Params(object value) => JsonSerializer.SerializeToElement(value);
    private static JsonElement Result(object? value) => JsonSerializer.SerializeToElement(value);
    private static int Index(JsonElement state, string name)
    {
        var tree = state.GetProperty("accessibility").GetProperty("tree").GetString()!;
        var line = tree.Split('\n').FirstOrDefault(x => x.Contains('"' + name + '"', StringComparison.Ordinal) || x.Contains("automation_id=\"" + name + "\"", StringComparison.Ordinal)) ?? throw new Exception($"Fixture element {name} absent from tree:\n{tree}");
        var from = line.IndexOf('[') + 1; var until = line.IndexOf(']', from);
        return int.Parse(line[from..until]);
    }
    private static void Assert(bool ok, string message) { if (!ok) throw new Exception("Fixture assertion failed: " + message); }
    private static void ExpectError(Action action, string code)
    {
        try { action(); } catch (RpcError ex) when (ex.Code == code) { return; }
        throw new Exception("Expected RPC error " + code);
    }
    private static Process Start(string name, bool cover = false)
    {
        var executable = Environment.ProcessPath ?? throw new InvalidOperationException("Missing process path.");
        var info = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true };
        info.ArgumentList.Add("--fixture"); info.ArgumentList.Add("--fixture-name"); info.ArgumentList.Add(name);
        if (cover) info.ArgumentList.Add("--cover");
        return Process.Start(info)!;
    }
    internal static object Test(Backend backend)
    {
        var checks = new List<string>();
        var name = "cpuse-native-test-" + Guid.NewGuid().ToString("N");
        using var fixture = Start(name);
        Process? occluder = null;
        try
        {
            TargetWindow? window = null;
            for (var i = 0; i < 100 && window == null; i++)
            {
                window = ((List<TargetWindow>)backend.Dispatch("list_windows", default)!).FirstOrDefault(x => x.title == name);
                if (window == null) Thread.Sleep(100);
            }
            Assert(window != null, "own fixture window enumeration"); checks.Add("list_windows/get_window identity");
            backend.Dispatch("get_window", Params(new { window!.id, window.app }));
            var apps = Result(backend.Dispatch("list_apps", default));
            Assert(apps.EnumerateArray().Any(x => x.GetProperty("windows").EnumerateArray().Any(w => w.GetProperty("id").GetInt64() == window.id)), "fixture appears in app catalog"); checks.Add("list_apps");
            JsonElement State(bool screenshot = false) => Result(backend.Dispatch("get_window_state", Params(new { window, include_text = true, include_screenshot = screenshot })));
            void Input(string method, JsonElement observed, object args)
            {
                var values = Params(args).EnumerateObject().ToDictionary(x => x.Name, x => (object)x.Value.Clone());
                values["window"] = window!;
                values["observation_id"] = observed.GetProperty("observation_id").GetString()!;
                if (observed.GetProperty("screenshots").GetArrayLength() > 0) values["screenshotId"] = observed.GetProperty("screenshots")[0].GetProperty("id").GetString()!;
                backend.Dispatch(method, Params(values));
            }
            var state = State();
            Assert(state.GetProperty("accessibility").GetProperty("tree").GetString()!.Contains("Fixture editor"), "UIA visible tree"); checks.Add("UIAutomation tree/focus");
            Assert(state.GetProperty("accessibility").GetProperty("focused_element").GetString()?.Contains("Fixture editor") == true, "UIA focused element");
            var edit = Index(state, "Fixture editor");
            backend.Dispatch("set_value", Params(new { window, observation_id = state.GetProperty("observation_id").GetString(), element_index = edit, value = "set by UIA" }));
            ExpectError(() => backend.Dispatch("set_value", Params(new { window, element_index = edit, value = "stale" })), "STALE_OBSERVATION");
            state = State(); Assert(state.GetProperty("accessibility").GetProperty("tree").GetString()!.Contains("set by UIA"), "SetValue reflected in UIA"); checks.Add("set_value + stale element rejection");
            Input("click", state, new { element_index = Index(state, "Fixture editor") });
            state = State(); Input("press_key", state, new { key = "Control_L+a" });
            state = State(); Input("type_text", state, new { text = "中文 Ω 😀 fixture" });
            Thread.Sleep(120); state = State();
            Assert(state.GetProperty("accessibility").GetProperty("tree").GetString()!.Contains("中文 Ω 😀 fixture"), "Unicode SendInput roundtrip"); checks.Add("click/press_key/type_text Unicode");
            Input("click", state, new { element_index = Index(state, "fixture-document-editor") });
            state = State(); Input("press_key", state, new { key = "Control_L+a" });
            state = State();
            Assert(state.GetProperty("accessibility").GetProperty("selected_text").GetString()?.Contains("Selected line") == true, "UIA TextPattern selected text");
            Input("type_text", state, new { text = "首行 Ω 😀\nsecond line\tindented" });
            Thread.Sleep(120); state = State();
            var documentText = state.GetProperty("accessibility").GetProperty("document_text").GetString();
            Assert(documentText?.Contains("首行 Ω 😀") == true && documentText.Contains("\n") && documentText.Contains("second line\tindented"), "multiline Unicode document text: " + JsonSerializer.Serialize(documentText));
            checks.Add("UIA TextPattern document/selection + multiline/tab Unicode");
            Input("perform_secondary_action", state, new { element_index = Index(state, "Fixture button"), action = "Invoke" });
            Thread.Sleep(100); state = State(); Assert(state.GetProperty("accessibility").GetProperty("tree").GetString()!.Contains("invoked"), "Invoke action"); checks.Add("perform_secondary_action Invoke");
            var captured = Result(backend.Dispatch("get_window_state", Params(new { window, include_text = true, include_screenshot = true })));
            var shot = captured.GetProperty("screenshots")[0];
            Assert(shot.GetProperty("capture_backend").GetString() == "windows-graphics-capture", "real WGC backend");
            var screenshotBounds = Win32.Bounds(new nint(window.id), true);
            Assert(shot.GetProperty("originX").GetInt32() == screenshotBounds.Left && shot.GetProperty("originY").GetInt32() == screenshotBounds.Top, "WGC origin matches DWM frame bounds");
            var png = Convert.FromBase64String(shot.GetProperty("url").GetString()!.Split(',')[1]);
            var artifacts = Path.Combine(AppContext.BaseDirectory, "test-artifacts"); Directory.CreateDirectory(artifacts);
            File.WriteAllBytes(Path.Combine(artifacts, "fixture-wgc.png"), png);
            using (var memory = new MemoryStream(png)) using (var bitmap = new Bitmap(memory)) Assert(bitmap.Width == shot.GetProperty("width").GetInt32() && bitmap.Height == shot.GetProperty("height").GetInt32(), "PNG dimensions match metadata");
            checks.Add("WGC PNG dimensions/origin");
            var oldObservation = captured.GetProperty("observation_id").GetString();
            var screenshot = shot.GetProperty("id").GetString();
            ExpectError(() => backend.Dispatch("click", Params(new { window, observation_id = oldObservation, screenshotId = screenshot, x = -1, y = 0 })), "COORDINATE_OUT_OF_BOUNDS");
            checks.Add("coordinate bounds rejection");
            // An independent top-level magenta window completely covers the green fixture.
            occluder = Start(name + "-cover", true);
            Thread.Sleep(650);
            var coverWindow = ((List<TargetWindow>)backend.Dispatch("list_windows", default)!).First(x => x.title == name + "-cover");
            backend.Dispatch("activate_window", Params(new { window = coverWindow }));
            Thread.Sleep(150);
            captured = Result(backend.Dispatch("get_window_state", Params(new { window, include_text = false, include_screenshot = true })));
            shot = captured.GetProperty("screenshots")[0];
            png = Convert.FromBase64String(shot.GetProperty("url").GetString()!.Split(',')[1]);
            File.WriteAllBytes(Path.Combine(artifacts, "fixture-occluded-wgc.png"), png);
            using (var memory = new MemoryStream(png)) using (var bitmap = new Bitmap(memory))
            {
                var pixel = bitmap.GetPixel(bitmap.Width - 40, bitmap.Height - 50);
                Assert(pixel.G > pixel.R + 30 && pixel.G > pixel.B + 30, "occluded WGC contains fixture green instead of foreground magenta");
            }
            checks.Add("WGC captures fully occluded window");
            occluder.Kill(); occluder.WaitForExit(5000); occluder.Dispose(); occluder = null;
            backend.Dispatch("activate_window", Params(new { window }));
            state = State();
            var toggle = Index(state, "Fixture toggle");
            Input("click", state, new { element_index = toggle });
            state = State(); Assert(state.GetProperty("accessibility").GetProperty("tree").GetString()!.Contains("value=\"On\""), "real mouse toggle"); checks.Add("mouse click");
            state = State(true);
            var beforeScroll = AutomationElement.FromHandle(new nint(window.id)).FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.NameProperty, "Fixture document")).Current.BoundingRectangle.Y;
            Input("scroll", state, new { x = 90, y = 220, scrollX = 0, scrollY = 360 });
            Thread.Sleep(100); state = State();
            var afterScroll = AutomationElement.FromHandle(new nint(window.id)).FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.NameProperty, "Fixture document")).Current.BoundingRectangle.Y;
            Assert(afterScroll < beforeScroll, "wheel moved scroll document upward"); checks.Add("wheel SendInput verified UIA displacement");
            state = State(true); Input("drag", state, new { from_x = 385, from_y = 240, to_x = 445, to_y = 290 });
            Thread.Sleep(100); state = State(); Assert(state.GetProperty("accessibility").GetProperty("tree").GetString()!.Contains("dragged"), "drag event reached fixture"); checks.Add("drag SendInput");
            var report = new { ok = true, checks, screenshot_artifacts = artifacts, capture_backend = "windows-graphics-capture", os = Environment.OSVersion.ToString(), runtime = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription, process_architecture = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString(), monitor_count = Screen.AllScreens.Length, fixture_dpi = Win32.GetDpiForWindow(new nint(window.id)), per_monitor_v2 = Win32.DpiAware, unverified = new[] { "Mixed-DPI multi-monitor behavior", "Accessibility on other applications and providers", "Elevated apps and locked desktop" } };
            File.WriteAllText(Path.Combine(artifacts, "native-integration-results.json"), JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
            return report;
        }
        finally
        {
            if (occluder != null) { if (!occluder.HasExited) occluder.Kill(); occluder.Dispose(); }
            if (!fixture.HasExited) { fixture.Kill(); fixture.WaitForExit(5000); }
        }
    }
}
