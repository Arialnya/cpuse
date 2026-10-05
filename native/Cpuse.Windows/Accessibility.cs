using System.Text;
using System.Text.Json;
using System.Windows.Automation;

namespace Cpuse.Windows;

internal sealed partial class Backend
{
    private object ReadAccessibility(WindowBinding b, Observation observation)
    {
        var root = AutomationElement.FromHandle(b.Handle);
        var lines = new StringBuilder();
        var selected = new List<string>();
        string? focusedLine = null, selectedText = null, documentText = null;
        AutomationElement? focused = null;
        try { var e = AutomationElement.FocusedElement; if (BelongsTo(e, b.Handle)) focused = e; } catch (ElementNotAvailableException) { }
        var pending = new Stack<(AutomationElement Element, int Depth)>();
        pending.Push((root, 0));
        while (pending.Count > 0 && observation.Elements.Count < MaxElements && lines.Length < 250_000)
        {
            var (element, depth) = pending.Pop();
            try
            {
                var info = element.Current;
                if (depth > 0 && info.IsOffscreen) continue;
                var index = observation.Elements.Count;
                observation.Elements[index] = element;
                var patternNames = Actions(element);
                var value = ReadValue(element);
                var rectangle = info.BoundingRectangle;
                var line = $"[{index}] {info.ControlType.ProgrammaticName.Replace("ControlType.", "")} \"{Clean(info.Name, 1000)}\"";
                if (!string.IsNullOrEmpty(value)) line += $" value=\"{Clean(value, 2000)}\"";
                if (!info.IsEnabled) line += " disabled";
                if (info.IsPassword) line += " password";
                if (!string.IsNullOrEmpty(info.AutomationId)) line += $" automation_id=\"{Clean(info.AutomationId, 200)}\"";
                if (!rectangle.IsEmpty) line += $" bounds=({rectangle.X:0},{rectangle.Y:0},{rectangle.Width:0},{rectangle.Height:0})";
                if (patternNames.Count > 0) line += " actions=[" + string.Join(", ", patternNames) + "]";
                lines.Append('\t', depth).AppendLine(line);
                if (focused != null && Automation.Compare(element, focused)) focusedLine = line;
                if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var selection) && ((SelectionItemPattern)selection).Current.IsSelected) selected.Add(line);
                if (!info.IsPassword && element.TryGetCurrentPattern(TextPattern.Pattern, out var textObject))
                {
                    var text = (TextPattern)textObject;
                    if (documentText == null || (focused != null && Automation.Compare(element, focused))) documentText = NormalizeNewlines(text.DocumentRange.GetText(100_000));
                    var ranges = text.GetSelection();
                    var textSelection = string.Join("\n", ranges.Select(x => NormalizeNewlines(x.GetText(20_000))).Where(x => !string.IsNullOrEmpty(x)));
                    if (!string.IsNullOrEmpty(textSelection)) selectedText = textSelection;
                }
                if (depth >= 32) continue;
                var children = new List<AutomationElement>();
                var child = TreeWalker.ControlViewWalker.GetFirstChild(element);
                while (child != null && children.Count < MaxElements)
                {
                    children.Add(child); child = TreeWalker.ControlViewWalker.GetNextSibling(child);
                }
                for (var i = children.Count - 1; i >= 0; i--) pending.Push((children[i], depth + 1));
            }
            catch (ElementNotAvailableException) { }
            catch (InvalidOperationException) { }
        }
        if (pending.Count > 0) lines.AppendLine("[tree truncated: maximum 1500 elements / depth 32 / 250000 characters]");
        return new { tree = lines.ToString(), focused_element = focusedLine, selected_elements = selected, selected_text = selectedText, document_text = documentText };
    }
    private static string Clean(string value, int maximum)
    {
        var clean = value.Replace("\r", " ").Replace("\n", " ").Replace("\t", " ").Replace("\"", "\\\"");
        return clean[..Math.Min(clean.Length, maximum)];
    }
    private static string NormalizeNewlines(string value) => value.Replace("\r\n", "\n").Replace('\r', '\n');
    private static string? ReadValue(AutomationElement e)
    {
        if (e.Current.IsPassword) return null;
        if (e.TryGetCurrentPattern(ValuePattern.Pattern, out var value)) return ((ValuePattern)value).Current.Value;
        if (e.TryGetCurrentPattern(RangeValuePattern.Pattern, out var range)) return ((RangeValuePattern)range).Current.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (e.TryGetCurrentPattern(TogglePattern.Pattern, out var toggle)) return ((TogglePattern)toggle).Current.ToggleState.ToString();
        return null;
    }
    private static List<string> Actions(AutomationElement e)
    {
        var result = new List<string>();
        if (e.Current.IsKeyboardFocusable) result.Add("Raise");
        if (e.TryGetCurrentPattern(InvokePattern.Pattern, out _)) result.Add("Invoke");
        if (e.TryGetCurrentPattern(ValuePattern.Pattern, out var value) && !((ValuePattern)value).Current.IsReadOnly) result.Add("Set Value");
        if (e.TryGetCurrentPattern(TogglePattern.Pattern, out _)) result.Add("Toggle");
        if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out _)) result.AddRange(new[] { "Select", "Add to Selection", "Remove from Selection" });
        if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var expanded))
        {
            var state = ((ExpandCollapsePattern)expanded).Current.ExpandCollapseState;
            if (state != ExpandCollapseState.LeafNode) result.AddRange(new[] { "Expand", "Collapse" });
        }
        if (e.TryGetCurrentPattern(ScrollPattern.Pattern, out var scroll))
        {
            var s = ((ScrollPattern)scroll).Current;
            if (s.VerticallyScrollable) result.AddRange(new[] { "Scroll Up", "Scroll Down" });
            if (s.HorizontallyScrollable) result.AddRange(new[] { "Scroll Left", "Scroll Right" });
        }
        if (e.TryGetCurrentPattern(ScrollItemPattern.Pattern, out _)) result.Add("Scroll Into View");
        return result;
    }
    private void SetValue(WindowBinding b, JsonElement p)
    {
        var element = Element(b, p);
        if (element.Current.IsPassword) throw new RpcError("PASSWORD_INPUT_FORBIDDEN", "Password elements cannot be edited through this plugin.");
        if (!element.Current.IsEnabled) throw new RpcError("ELEMENT_DISABLED", "Element is disabled.");
        Activate(b);
        var value = String(p, "value");
        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var pattern))
        {
            var editable = (ValuePattern)pattern;
            if (editable.Current.IsReadOnly) throw new RpcError("ELEMENT_READ_ONLY", "The element value is read-only.");
            editable.SetValue(value); return;
        }
        if (element.TryGetCurrentPattern(RangeValuePattern.Pattern, out var rangePattern))
        {
            var range = (RangeValuePattern)rangePattern;
            if (range.Current.IsReadOnly) throw new RpcError("ELEMENT_READ_ONLY", "The range value is read-only.");
            if (!double.TryParse(value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var number) || !double.IsFinite(number) || number < range.Current.Minimum || number > range.Current.Maximum) throw new RpcError("INVALID_VALUE", "Value must be a number within the element range.");
            range.SetValue(number); return;
        }
        throw new RpcError("PATTERN_UNSUPPORTED", "Element does not expose an editable Value or RangeValue pattern.");
    }
    private void SecondaryAction(WindowBinding b, JsonElement p)
    {
        var element = Element(b, p);
        if (element.Current.IsPassword) throw new RpcError("PASSWORD_INPUT_FORBIDDEN", "Password elements cannot be controlled through this plugin.");
        var action = String(p, "action");
        if (!Actions(element).Contains(action, StringComparer.OrdinalIgnoreCase)) throw new RpcError("ACTION_UNSUPPORTED", "Action is not advertised by the selected element.");
        Activate(b);
        switch (action.ToLowerInvariant())
        {
            case "raise": element.SetFocus(); break;
            case "invoke": ((InvokePattern)element.GetCurrentPattern(InvokePattern.Pattern)).Invoke(); break;
            case "toggle": ((TogglePattern)element.GetCurrentPattern(TogglePattern.Pattern)).Toggle(); break;
            case "expand": ((ExpandCollapsePattern)element.GetCurrentPattern(ExpandCollapsePattern.Pattern)).Expand(); break;
            case "collapse": ((ExpandCollapsePattern)element.GetCurrentPattern(ExpandCollapsePattern.Pattern)).Collapse(); break;
            case "select": ((SelectionItemPattern)element.GetCurrentPattern(SelectionItemPattern.Pattern)).Select(); break;
            case "add to selection": ((SelectionItemPattern)element.GetCurrentPattern(SelectionItemPattern.Pattern)).AddToSelection(); break;
            case "remove from selection": ((SelectionItemPattern)element.GetCurrentPattern(SelectionItemPattern.Pattern)).RemoveFromSelection(); break;
            case "scroll into view": ((ScrollItemPattern)element.GetCurrentPattern(ScrollItemPattern.Pattern)).ScrollIntoView(); break;
            case "scroll up": ((ScrollPattern)element.GetCurrentPattern(ScrollPattern.Pattern)).Scroll(ScrollAmount.NoAmount, ScrollAmount.LargeDecrement); break;
            case "scroll down": ((ScrollPattern)element.GetCurrentPattern(ScrollPattern.Pattern)).Scroll(ScrollAmount.NoAmount, ScrollAmount.LargeIncrement); break;
            case "scroll left": ((ScrollPattern)element.GetCurrentPattern(ScrollPattern.Pattern)).Scroll(ScrollAmount.LargeDecrement, ScrollAmount.NoAmount); break;
            case "scroll right": ((ScrollPattern)element.GetCurrentPattern(ScrollPattern.Pattern)).Scroll(ScrollAmount.LargeIncrement, ScrollAmount.NoAmount); break;
            default: throw new RpcError("ACTION_UNSUPPORTED", "Use set_value for Set Value actions.");
        }
    }
}
