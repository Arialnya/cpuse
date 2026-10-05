using System.Diagnostics;
using System.Drawing;
using System.Text.Json;
using System.Windows.Automation;
using System.Windows.Forms;

namespace Cpuse.Windows;

internal static class Fixture
{
    private sealed class RejectPacketFilter(Func<nint> target) : IMessageFilter
    {
        public bool PreFilterMessage(ref Message message) => message.HWnd == target() && (message.Msg is 0x0100 or 0x0104) && message.WParam == new nint(0xE7);
    }

    private sealed class GameSurface : Control
    {
        internal bool ClearNativeFocus { get; init; }
        internal GameSurface() { SetStyle(ControlStyles.Selectable, true); TabStop = true; BackColor = Color.Navy; }
        protected override void OnMouseDown(MouseEventArgs e) { Focus(); base.OnMouseDown(e); if (ClearNativeFocus) Win32.SetFocus(0); }
        protected override bool IsInputKey(Keys keyData) => true;
    }

    internal static void Run(string[] args)
    {
        Application.EnableVisualStyles();
        var name = args.ElementAtOrDefault(Array.IndexOf(args, "--fixture-name") + 1) ?? "cpuse-fixture";
        var cover = args.Contains("--cover");
        using var form = new Form { Text = args.Contains("--untitled") ? "" : name, Width = 600, Height = 440, Left = 250, Top = 150, StartPosition = FormStartPosition.Manual, BackColor = cover ? Color.Magenta : Color.FromArgb(20, 140, 70) };
        if (!cover)
        {
            var edit = new TextBox { Name = "fixture-edit", Text = "initial", Left = 20, Top = 20, Width = 300, AccessibleName = "Fixture editor" };
            var result = new Label { Name = "fixture-result", Text = "idle", Left = 20, Top = 95, Width = 300 };
            var button = new Button { Name = "fixture-button", Text = "Invoke fixture", Left = 20, Top = 55, Width = 150, AccessibleName = "Fixture button" };
            button.Click += (_, _) => result.Text = "invoked";
            var check = new CheckBox { Name = "fixture-toggle", Text = "Fixture toggle", Left = 190, Top = 55, Width = 140, AccessibleName = "Fixture toggle" };
            var document = new RichTextBox { Name = "fixture-document-editor", Text = "Document initial\nSelected line", Left = 350, Top = 20, Width = 210, Height = 130, AccessibleName = "Fixture document editor", AcceptsTab = true };
            var filtered = new TextBox { Name = "fixture-packet-reject", Text = "packet-initial", Left = 250, Top = 330, Width = 280, AccessibleName = "Fixture packet reject editor" };
            var password = new TextBox { Name = "fixture-password", Left = 20, Top = 330, Width = 200, AccessibleName = "Fixture password", UseSystemPasswordChar = true };
            var game = new GameSurface { Name = "fixture-game", Left = 485, Top = 175, Width = 75, Height = 80, AccessibleName = "Fixture game surface" };
            var noFocusGame = new GameSurface { Name = "fixture-game-no-focus", Left = 485, Top = 265, Width = 75, Height = 35, AccessibleName = "Fixture game without focus", ClearNativeFocus = true };
            var gameKeys = new Label { Name = "fixture-game-keys", Text = "game keys=0", Left = 250, Top = 295, Width = 230, Height = 30 };
            var keyCount = 0;
            game.KeyDown += (_, e) => { if (e.KeyCode == Keys.F6) gameKeys.Text = "game keys=" + ++keyCount; };
            Application.AddMessageFilter(new RejectPacketFilter(() => filtered.Handle));
            var panel = new Panel { Name = "fixture-scroll", Left = 20, Top = 130, Width = 220, Height = 180, AutoScroll = true, AccessibleName = "Fixture scroll" };
            var tall = new Label { Text = "Scroll document\n" + string.Join("\n", Enumerable.Range(1, 30)), Width = 180, Height = 650, AccessibleName = "Fixture document" };
            panel.Controls.Add(tall);
            var box = new Panel { Name = "fixture-drag", BackColor = Color.Cyan, Left = 350, Top = 180, Width = 60, Height = 60, AccessibleName = "Fixture draggable" };
            Point? origin = null;
            box.MouseDown += (_, e) => { origin = e.Location; box.Capture = true; };
            box.MouseMove += (_, e) => { if (origin is Point start && e.Button == MouseButtons.Left) { box.Left += e.X - start.X; box.Top += e.Y - start.Y; } };
            box.MouseUp += (_, _) => { origin = null; box.Capture = false; result.Text = "dragged"; };
            form.Controls.AddRange(new Control[] { edit, button, check, result, panel, box, document, filtered, password, game, noFocusGame, gameKeys });
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
    private static Process Start(string name, bool cover = false, bool untitled = false)
    {
        var executable = Environment.ProcessPath ?? throw new InvalidOperationException("Missing process path.");
        var info = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true };
        info.ArgumentList.Add("--fixture"); info.ArgumentList.Add("--fixture-name"); info.ArgumentList.Add(name);
        if (cover) info.ArgumentList.Add("--cover");
        if (untitled) info.ArgumentList.Add("--untitled");
        return Process.Start(info)!;
    }
    internal static object Test(Backend backend)
    {
        var checks = new List<string>();
        var name = "cpuse-native-test-" + Guid.NewGuid().ToString("N");
        using var fixture = Start(name);
        Process? occluder = null;
        Process? untitledFixture = null;
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
            JsonElement Input(string method, JsonElement observed, object args)
            {
                var values = Params(args).EnumerateObject().ToDictionary(x => x.Name, x => (object)x.Value.Clone());
                values["window"] = window!;
                values["observation_id"] = observed.GetProperty("observation_id").GetString()!;
                if (observed.GetProperty("screenshots").GetArrayLength() > 0) values["screenshotId"] = observed.GetProperty("screenshots")[0].GetProperty("id").GetString()!;
                return Result(backend.Dispatch(method, Params(values)));
            }
            var state = State();
            Assert(window!.process_name == Path.GetFileNameWithoutExtension(Environment.ProcessPath) && !string.IsNullOrEmpty(window.class_name), "verified process/class discovery metadata");
            Assert(state.GetProperty("input").GetProperty("injection").GetString() == "allowed", "equal integrity fixture permitted");
            Assert(!state.GetProperty("input").GetProperty("text_methods").EnumerateArray().Any(x => x.GetString() == "paste"), "clipboard paste absent without trusted host opt-in");
            checks.Add("per-target UIPI/focus diagnostics + clipboard default off");
            Assert(state.GetProperty("accessibility").GetProperty("tree").GetString()!.Contains("Fixture editor"), "UIA visible tree"); checks.Add("UIAutomation tree/focus");
            Assert(state.GetProperty("accessibility").GetProperty("focused_element").GetString()?.Contains("Fixture editor") == true, "UIA focused element");
            var edit = Index(state, "Fixture editor");
            backend.Dispatch("set_value", Params(new { window, observation_id = state.GetProperty("observation_id").GetString(), element_index = edit, value = "set by UIA" }));
            ExpectError(() => backend.Dispatch("set_value", Params(new { window, element_index = edit, value = "stale" })), "STALE_OBSERVATION");
            state = State(); Assert(state.GetProperty("accessibility").GetProperty("tree").GetString()!.Contains("set by UIA"), "SetValue reflected in UIA"); checks.Add("set_value + stale element rejection");
            Input("click", state, new { element_index = Index(state, "Fixture editor") });
            state = State(); Input("press_key", state, new { key = "Control_L+a" });
            state = State(); var textReceipt = Input("type_text", state, new { text = "中文 Ω 😀 fixture" });
            Assert(textReceipt.GetProperty("receipt").GetProperty("status").GetString() == "text_changed", "literal Unicode reports observable text change");
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
            Input("click", state, new { element_index = Index(state, "Fixture packet reject editor") });
            state = State(); Input("press_key", state, new { key = "Control_L+a" });
            state = State();
            ExpectError(() => Input("type_text", state, new { text = "filtered Unicode did not arrive" }), "INPUT_NOT_ACCEPTED");
            state = State();
            Assert(state.GetProperty("accessibility").GetProperty("tree").GetString()!.Contains("packet-initial"), "filtered VK_PACKET text did not change editor");
            ExpectError(() => Input("type_text", state, new { text = "disabled paste", method = "paste" }), "CLIPBOARD_UNAVAILABLE");
            checks.Add("VK_PACKET filtering detected + disabled paste refusal");
            state = State();
            var pasteVerified = false;
            string? pasteUnverifiedReason = null;
            try
            {
                // Preserve the user's clipboard; unsupported original handle formats
                // are refused before it is changed, including for this fixture.
                var originalClipboardText = Clipboard.ContainsText() ? Clipboard.GetText() : null;
                var paste = Input("type_text", state, new { text = "粘贴 Ω 😀 fixture paste", method = "paste", allow_clipboard_paste = true });
                Assert(paste.GetProperty("receipt").GetProperty("status").GetString() == "text_changed", "paste reaches VK_PACKET filtering control");
                Assert((Clipboard.ContainsText() ? Clipboard.GetText() : null) == originalClipboardText, "original clipboard text presence/value restored after paste");
                pasteVerified = true;
                checks.Add("opt-in Unicode clipboard paste + original clipboard restoration");
            }
            catch (RpcError ex) when (ex.Code == "CLIPBOARD_UNAVAILABLE")
            {
                pasteUnverifiedReason = ex.Message;
                checks.Add("unsupported original clipboard safely refuses paste");
            }
            state = State(); Input("click", state, new { element_index = Index(state, "Fixture password") });
            state = State();
            Assert(state.GetProperty("input").GetProperty("focus").GetProperty("password").GetString() == "yes", "native/UIA password focus detected");
            ExpectError(() => Input("type_text", state, new { text = "must not be entered" }), "PASSWORD_INPUT_FORBIDDEN");
            checks.Add("native password controls remain blocked");
            state = State(); Input("click", state, new { element_index = Index(state, "Fixture game surface") });
            Thread.Sleep(60);
            state = Result(backend.Dispatch("get_window_state", Params(new { window, include_text = false, include_screenshot = false })));
            Assert(state.GetProperty("accessibility").ValueKind == JsonValueKind.Null && state.GetProperty("input").GetProperty("focus").GetProperty("source").GetString() == "win32", "game screenshot-only path uses Win32 focus without UIA");
            Assert(!state.GetProperty("input").GetProperty("focus").GetProperty("can_type").GetBoolean(), "custom focus without password classification does not allow text");
            var gameReceipt = Input("press_key", state, new { key = "F6", mode = "scan-code" });
            Assert(gameReceipt.GetProperty("receipt").GetProperty("status").GetString() == "queued_unverified", "scan codes report queue status");
            Thread.Sleep(100); state = State();
            Assert(state.GetProperty("accessibility").GetProperty("tree").GetString()!.Contains("game keys=1"), "custom game control receives scan code once");
            checks.Add("window-scoped scan codes reach custom game control");
            Input("click", state, new { element_index = Index(state, "Fixture game without focus") });
            Thread.Sleep(60);
            JsonElement NoUiaState() => Result(backend.Dispatch("get_window_state", Params(new { window, include_text = false, include_screenshot = false })));
            state = NoUiaState();
            Assert(state.GetProperty("input").GetProperty("focus").GetProperty("in_window").GetBoolean() && !state.GetProperty("input").GetProperty("focus").GetProperty("can_type").GetBoolean(), "recent verified click binds active queue but never grants literal text");
            ExpectError(() => Input("press_key", state, new { key = "F6", mode = "virtual-key" }), "FOCUS_FAILED");
            state = NoUiaState();
            var noFocusReceipt = Input("press_key", state, new { key = "F6", mode = "scan-code" });
            Assert(noFocusReceipt.GetProperty("receipt").GetProperty("status").GetString() == "queued_unverified", "focusless clicked game queue reports uncertain delivery");
            checks.Add("focusless game queue permitted only for scan codes after verified click");
            state = State();
            Input("perform_secondary_action", state, new { element_index = Index(state, "Fixture button"), action = "Invoke" });
            Thread.Sleep(100); state = State(); Assert(state.GetProperty("accessibility").GetProperty("tree").GetString()!.Contains("invoked"), "Invoke action"); checks.Add("perform_secondary_action Invoke");
            var captured = Result(backend.Dispatch("get_window_state", Params(new { window, include_text = true, include_screenshot = true })));
            Assert(typeof(Capture).GetMethod("ScreenCapture", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static) == null, "desktop BitBlt fallback is not exposed by the capture implementation");
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
            var foregroundBeforeObservation = Win32.GetForegroundWindow();
            captured = Result(backend.Dispatch("get_window_state", Params(new { window, include_text = false, include_screenshot = true })));
            Assert(Win32.GetForegroundWindow() == foregroundBeforeObservation, "observing a covered window does not activate it");
            shot = captured.GetProperty("screenshots")[0];
            png = Convert.FromBase64String(shot.GetProperty("url").GetString()!.Split(',')[1]);
            File.WriteAllBytes(Path.Combine(artifacts, "fixture-occluded-wgc.png"), png);
            using (var memory = new MemoryStream(png)) using (var bitmap = new Bitmap(memory))
            {
                var pixel = bitmap.GetPixel(bitmap.Width - 40, bitmap.Height - 50);
                Assert(pixel.G > pixel.R + 30 && pixel.G > pixel.B + 30, "occluded WGC contains fixture green instead of foreground magenta");
            }
            checks.Add("WGC captures fully occluded window");
            checks.Add("capture does not activate windows or fall back to desktop pixels");
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
            untitledFixture = Start(name + "-untitled", untitled: true);
            TargetWindow? untitled = null;
            for (var i = 0; i < 40 && untitled == null; i++)
            {
                untitled = ((List<TargetWindow>)backend.Dispatch("list_windows", default)!).FirstOrDefault(x => { Win32.GetWindowThreadProcessId(new nint(x.id), out var pid); return pid == (uint)untitledFixture.Id; });
                if (untitled == null) Thread.Sleep(100);
            }
            Assert(untitled != null && untitled.title == "" && untitled.process_name == window.process_name && !string.IsNullOrEmpty(untitled.class_name), "untitled window discovered by verified process/class identity");
            checks.Add("untitled game-style window discovery without guessing HWND");
            var report = new { ok = true, checks, clipboard_paste_verified = pasteVerified, clipboard_paste_unverified_reason = pasteUnverifiedReason, screenshot_artifacts = artifacts, capture_backend = "windows-graphics-capture", os = Environment.OSVersion.ToString(), runtime = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription, process_architecture = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString(), monitor_count = Screen.AllScreens.Length, fixture_dpi = Win32.GetDpiForWindow(new nint(window.id)), per_monitor_v2 = Win32.DpiAware, unverified = new[] { "Mixed-DPI multi-monitor behavior", "Accessibility on other applications and providers", "Elevated apps and locked desktop", "Raw-input/driver-filtered games and Slay the Spire 2 actual gameplay" } };
            File.WriteAllText(Path.Combine(artifacts, "native-integration-results.json"), JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
            return report;
        }
        finally
        {
            if (occluder != null) { if (!occluder.HasExited) occluder.Kill(); occluder.Dispose(); }
            if (untitledFixture != null) { if (!untitledFixture.HasExited) { untitledFixture.Kill(); untitledFixture.WaitForExit(5000); } untitledFixture.Dispose(); }
            if (!fixture.HasExited) { fixture.Kill(); fixture.WaitForExit(5000); }
        }
    }
}
