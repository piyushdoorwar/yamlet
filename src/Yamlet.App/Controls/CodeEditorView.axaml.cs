using System;
using System.Text.Json;
using System.Text.RegularExpressions;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Input;
using Avalonia.Markup.Xaml;
using Avalonia.Media;
using AvaloniaEdit;
using AvaloniaEdit.CodeCompletion;
using AvaloniaEdit.Document;
using AvaloniaEdit.Editing;
using AvaloniaEdit.Folding;
using AvaloniaEdit.Rendering;
using AvaloniaEdit.Search;
using Yamlet.App.Services;

namespace Yamlet.App.Controls;

/// <summary>
/// A compact code editor (AvaloniaEdit-backed) with line numbers, JSON beautify, and
/// <c>{{variable}}</c> highlighting: placeholders render amber when they
/// resolve in the active scopes and red when undefined, and clicking one opens an
/// inspector to view or set its value. Variable features activate only when a
/// <see cref="VariableSource"/> is supplied.
/// </summary>
public partial class CodeEditorView : UserControl
{
    private static readonly Regex PlaceholderPattern =
        new(@"\{\{\s*([^{}\s]+)\s*\}\}", RegexOptions.Compiled);
    private static readonly Regex JsonStringPattern =
        new("\"(?:\\\\.|[^\"\\\\])*\"", RegexOptions.Compiled);
    private static readonly Regex JsonLiteralPattern =
        new(@"(?<![\w.])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b(?:true|false|null)\b", RegexOptions.Compiled);

    public static readonly StyledProperty<string> TextProperty =
        AvaloniaProperty.Register<CodeEditorView, string>(
            nameof(Text),
            string.Empty,
            defaultBindingMode: Avalonia.Data.BindingMode.TwoWay);

    public static readonly StyledProperty<string> LanguageProperty =
        AvaloniaProperty.Register<CodeEditorView, string>(nameof(Language), "text");

    public static readonly StyledProperty<bool> IsReadOnlyProperty =
        AvaloniaProperty.Register<CodeEditorView, bool>(nameof(IsReadOnly));

    public static readonly StyledProperty<bool> AllowBeautifyProperty =
        AvaloniaProperty.Register<CodeEditorView, bool>(nameof(AllowBeautify));

    public static readonly StyledProperty<IVariableSource?> VariableSourceProperty =
        AvaloniaProperty.Register<CodeEditorView, IVariableSource?>(nameof(VariableSource));

    /// <summary>How a <c>{{placeholder}}</c> should be colored.</summary>
    private enum VarHighlight { None, Defined, Empty, Undefined }

    private readonly TextEditor _editor;
    private readonly IBrush _definedBrush;
    private readonly IBrush _emptyBrush;
    private readonly IBrush _undefinedBrush;
    private readonly IBrush _jsonKeyBrush;
    private readonly IBrush _jsonValueBrush;
    private readonly JsonFoldingStrategy _foldingStrategy = new();
    private FoldingManager? _foldingManager;
    private CompletionWindow? _completionWindow;
    private bool _syncing;
    private IVariableSource? _subscribed;
    private string _popupVariable = string.Empty;
    private string _peekVariable = string.Empty;

    public CodeEditorView()
    {
        AvaloniaXamlLoader.Load(this);

        _definedBrush = FindBrush("VariableDefinedBrush", "#FFE0A458");
        _emptyBrush = FindBrush("TextMutedBrush", "#FF8A877D");
        _undefinedBrush = FindBrush("VariableUndefinedBrush", "#FFE2655A");
        _jsonKeyBrush = FindBrush("JsonKeyBrush", "#FF9CC0EC");
        _jsonValueBrush = FindBrush("JsonValueBrush", "#FF8FD3A8");

        _editor = this.FindControl<TextEditor>("EditorBox")!;
        _editor.Options.EnableHyperlinks = false;
        _editor.Options.EnableEmailHyperlinks = false;
        _editor.Text = Text ?? string.Empty;
        _editor.TextChanged += OnEditorTextChanged;
        _editor.TextArea.TextView.LineTransformers.Add(
            new JsonSyntaxColorizer(() => string.Equals(Language, "json", StringComparison.OrdinalIgnoreCase),
                _jsonKeyBrush,
                _jsonValueBrush));
        _editor.TextArea.TextView.LineTransformers.Add(new VariableColorizer(VariableState, _definedBrush, _emptyBrush, _undefinedBrush));
        _editor.AddHandler(PointerPressedEvent, OnEditorPointerPressed, Avalonia.Interactivity.RoutingStrategies.Tunnel, handledEventsToo: true);
        _editor.TextArea.TextView.PointerMoved += OnEditorPointerMoved;
        _editor.TextArea.TextView.PointerExited += OnEditorPointerExited;
        _editor.TextArea.TextEntered += OnEditorTextEntered;
        SearchPanel.Install(_editor);
        UpdateFolding();
    }

    public string Text
    {
        get => GetValue(TextProperty);
        set => SetValue(TextProperty, value);
    }

    public string Language
    {
        get => GetValue(LanguageProperty);
        set => SetValue(LanguageProperty, value);
    }

    public bool IsReadOnly
    {
        get => GetValue(IsReadOnlyProperty);
        set => SetValue(IsReadOnlyProperty, value);
    }

    public bool AllowBeautify
    {
        get => GetValue(AllowBeautifyProperty);
        set => SetValue(AllowBeautifyProperty, value);
    }

    /// <summary>Optional provider that powers {{variable}} highlighting and editing.</summary>
    public IVariableSource? VariableSource
    {
        get => GetValue(VariableSourceProperty);
        set => SetValue(VariableSourceProperty, value);
    }

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);

        if (change.Property == TextProperty && !_syncing)
        {
            var incoming = Text ?? string.Empty;
            if (_editor.Text != incoming)
            {
                _syncing = true;
                _editor.Text = incoming;
                _syncing = false;
            }
        }
        else if (change.Property == VariableSourceProperty)
        {
            if (_subscribed is not null)
            {
                _subscribed.VariablesChanged -= OnVariablesChanged;
            }
            _subscribed = VariableSource;
            if (_subscribed is not null)
            {
                _subscribed.VariablesChanged += OnVariablesChanged;
            }
            _editor.TextArea.TextView.Redraw();
        }
        else if (change.Property == LanguageProperty)
        {
            UpdateFolding();
            _editor.TextArea.TextView.Redraw();
        }
    }

    private void OnVariablesChanged(object? sender, EventArgs e) => _editor.TextArea.TextView.Redraw();

    private void OnEditorTextChanged(object? sender, EventArgs e)
    {
        if (!_syncing)
        {
            _syncing = true;
            SetValue(TextProperty, _editor.Text);
            _syncing = false;
        }

        UpdateFolding();
    }

    /// <summary>Installs/refreshes JSON code folding when the editor is showing JSON.</summary>
    private void UpdateFolding()
    {
        if (string.Equals(Language, "json", StringComparison.OrdinalIgnoreCase))
        {
            if (_foldingManager is null)
            {
                _foldingManager = FoldingManager.Install(_editor.TextArea);
                ThemeFoldingMargin();
            }
            _foldingStrategy.UpdateFoldings(_foldingManager, _editor.Document);
        }
        else if (_foldingManager is not null)
        {
            FoldingManager.Uninstall(_foldingManager);
            _foldingManager = null;
        }
    }

    /// <summary>Recolors the fold gutter markers to muted theme tones so they blend in
    /// rather than showing AvaloniaEdit's default stark boxes.</summary>
    private void ThemeFoldingMargin()
    {
        var margin = _editor.TextArea.LeftMargins.OfType<FoldingMargin>().FirstOrDefault();
        if (margin is null)
        {
            return;
        }

        var marker = FindBrush("TextMutedBrush", "#FF8A877D");
        var markerActive = FindBrush("TextSecondaryBrush", "#FFB7B4AA");
        var fill = FindBrush("PanelBrush", "#FF2F2E2B");

        margin.FoldingMarkerBrush = marker;
        margin.FoldingMarkerBackgroundBrush = fill;
        margin.SelectedFoldingMarkerBrush = markerActive;
        margin.SelectedFoldingMarkerBackgroundBrush = fill;
    }

    // ---- Variable inspector --------------------------------------------------

    private VarHighlight VariableState(string name)
    {
        var source = VariableSource;
        if (source is not null && source.TryGetValue(name, out var value))
        {
            // Resolves, but the value is empty → grey, so blank variables are visible.
            return string.IsNullOrEmpty(value) ? VarHighlight.Empty : VarHighlight.Defined;
        }

        // Dynamic variables ($guid, $random*, …) always resolve at send time → amber.
        if (DynamicVariables.IsDynamic(name))
        {
            return VarHighlight.Defined;
        }

        return source is null ? VarHighlight.None : VarHighlight.Undefined;
    }

    private void OnEditorPointerPressed(object? sender, PointerPressedEventArgs e)
    {
        if (VariableSource is null || !e.GetCurrentPoint(_editor).Properties.IsLeftButtonPressed)
        {
            return;
        }

        var name = VariableAt(e.GetPosition(_editor.TextArea.TextView));
        if (name is null)
        {
            return;
        }

        // Dynamic variables ($guid, $random*) are generated, not settable — no inspector.
        if (Yamlet.App.Services.DynamicVariables.IsDynamic(name) && !VariableSource.TryGetValue(name, out _))
        {
            return;
        }

        OpenInspector(name);
    }

    /// <summary>Returns the variable name under a point in TextView coordinates, or null.</summary>
    private string? VariableAt(Avalonia.Point pointInTextView)
    {
        var textView = _editor.TextArea.TextView;
        var position = textView.GetPositionFloor(pointInTextView + textView.ScrollOffset);
        if (position is null)
        {
            return null;
        }

        var offset = _editor.Document.GetOffset(position.Value.Location);
        var line = _editor.Document.GetLineByOffset(offset);
        var lineText = _editor.Document.GetText(line);
        var column = offset - line.Offset;

        foreach (Match match in PlaceholderPattern.Matches(lineText))
        {
            if (column >= match.Index && column <= match.Index + match.Length)
            {
                return match.Groups[1].Value;
            }
        }

        return null;
    }

    private void OnEditorPointerMoved(object? sender, PointerEventArgs e)
    {
        var name = VariableAt(e.GetPosition(_editor.TextArea.TextView));
        if (name is null)
        {
            ClosePeek();
            return;
        }

        if (string.Equals(name, _peekVariable, StringComparison.Ordinal) &&
            this.FindControl<Popup>("VarPeekPopup") is { IsOpen: true })
        {
            return;
        }

        ShowPeek(name);
    }

    private void OnEditorPointerExited(object? sender, PointerEventArgs e) => ClosePeek();

    private void ShowPeek(string name)
    {
        var source = VariableSource;
        var defined = source is not null && source.TryGetValue(name, out _);
        var dynamic = !defined ? Yamlet.App.Services.DynamicVariables.Find(name) : null;

        // Nothing to show: not a user variable, not a dynamic one.
        if (!defined && dynamic is null)
        {
            ClosePeek();
            return;
        }

        var nameText = this.FindControl<TextBlock>("PeekNameText")!;
        var valueText = this.FindControl<TextBlock>("PeekValueText")!;
        var scopeText = this.FindControl<TextBlock>("PeekScopeText")!;
        var popup = this.FindControl<Popup>("VarPeekPopup")!;

        nameText.Text = name;

        if (defined)
        {
            source!.TryGetValue(name, out var value);
            var empty = string.IsNullOrEmpty(value);
            nameText.Foreground = empty ? _emptyBrush : _definedBrush;
            valueText.Text = empty ? "(empty)" : value;
            scopeText.Text = $"Resolved with {source.TargetScopeName}";
        }
        else
        {
            nameText.Foreground = _definedBrush;
            valueText.Text = dynamic!.Description;
            scopeText.Text = $"Dynamic variable — generated each use (e.g. {dynamic.Example})";
        }

        // Re-anchor at the new pointer location by toggling open state.
        popup.IsOpen = false;
        _peekVariable = name;
        popup.IsOpen = true;
    }

    private void ClosePeek()
    {
        _peekVariable = string.Empty;
        if (this.FindControl<Popup>("VarPeekPopup") is { } popup)
        {
            popup.IsOpen = false;
        }
    }

    private void OpenInspector(string name)
    {
        ClosePeek();
        _popupVariable = name;

        var nameText = this.FindControl<TextBlock>("VarNameText")!;
        var statusText = this.FindControl<TextBlock>("VarStatusText")!;
        var scopeText = this.FindControl<TextBlock>("VarScopeText")!;
        var valueBox = this.FindControl<TextBox>("VarValueBox")!;
        var popup = this.FindControl<Popup>("VarPopup")!;

        var defined = VariableSource!.TryGetValue(name, out var value);
        nameText.Text = name;
        nameText.Foreground = defined
            ? (string.IsNullOrEmpty(value) ? _emptyBrush : _definedBrush)
            : _undefinedBrush;
        statusText.Text = defined ? "Defined — current value:" : "Not defined in any active scope yet.";
        valueBox.Text = defined ? value : string.Empty;
        scopeText.Text = $"Saves to: {VariableSource.TargetScopeName}";

        popup.IsOpen = true;
        valueBox.Focus();
    }

    private async void OnVarSaveClicked(object? sender, Avalonia.Interactivity.RoutedEventArgs e)
    {
        var valueBox = this.FindControl<TextBox>("VarValueBox")!;
        var popup = this.FindControl<Popup>("VarPopup")!;
        var source = VariableSource;

        popup.IsOpen = false;
        if (source is not null && !string.IsNullOrEmpty(_popupVariable))
        {
            await source.SetAsync(_popupVariable, valueBox.Text ?? string.Empty);
            _editor.TextArea.TextView.Redraw();
        }
    }

    private void OnVarCancelClicked(object? sender, Avalonia.Interactivity.RoutedEventArgs e) =>
        this.FindControl<Popup>("VarPopup")!.IsOpen = false;

    // ---- Dynamic-variable autocomplete --------------------------------------

    /// <summary>
    /// Pops a completion list of Postman-style dynamic variables when the user types
    /// <c>$</c> (typically inside <c>{{ }}</c>). Typing more characters filters the list;
    /// accepting one inserts the variable name after the <c>$</c>.
    /// </summary>
    private void OnEditorTextEntered(object? sender, TextInputEventArgs e)
    {
        if (IsReadOnly || e.Text != "$" || _completionWindow is not null)
        {
            return;
        }

        var window = new CompletionWindow(_editor.TextArea)
        {
            CloseAutomatically = true,
            CloseWhenCaretAtBeginning = true,
        };

        foreach (var dynamic in DynamicVariables.All)
        {
            window.CompletionList.CompletionData.Add(new DynamicVariableCompletion(dynamic));
        }

        window.Closed += (_, _) => _completionWindow = null;
        _completionWindow = window;
        window.Show();
    }

    /// <summary>One row in the dynamic-variable completion popup.</summary>
    private sealed class DynamicVariableCompletion : ICompletionData
    {
        private readonly DynamicVariable _variable;

        public DynamicVariableCompletion(DynamicVariable variable) => _variable = variable;

        // Text excludes the leading "$" (already typed), so accepting inserts the rest.
        public string Text => _variable.Name.TrimStart('$');

        public IImage? Image => null;

        public object Content => _variable.Name;

        public object Description => string.IsNullOrEmpty(_variable.Example)
            ? _variable.Description
            : $"{_variable.Description}\nExample: {_variable.Example}";

        public double Priority => 0;

        public void Complete(TextArea textArea, ISegment completionSegment, EventArgs insertionRequestEventArgs) =>
            textArea.Document.Replace(completionSegment, Text);
    }

    // ---- Beautify ------------------------------------------------------------

    private void OnBeautifyClicked(object? sender, Avalonia.Interactivity.RoutedEventArgs e)
    {
        if (TryBeautifyJson(Text, out var formatted))
        {
            Text = formatted;
        }
    }

    private static bool TryBeautifyJson(string input, out string formatted)
    {
        formatted = input;
        if (string.IsNullOrWhiteSpace(input))
        {
            return false;
        }

        try
        {
            using var doc = JsonDocument.Parse(input);
            formatted = JsonSerializer.Serialize(
                doc.RootElement,
                new JsonSerializerOptions { WriteIndented = true });
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private IBrush FindBrush(string key, string fallbackHex)
    {
        if (Application.Current is { } app &&
            app.TryGetResource(key, app.ActualThemeVariant, out var value) &&
            value is IBrush brush)
        {
            return brush;
        }

        return new SolidColorBrush(Color.Parse(fallbackHex));
    }

    /// <summary>Small JSON colorizer: property names use soft blue; values use Yamlet green.</summary>
    private sealed class JsonSyntaxColorizer : DocumentColorizingTransformer
    {
        private readonly Func<bool> _isJson;
        private readonly IBrush _key;
        private readonly IBrush _value;

        public JsonSyntaxColorizer(Func<bool> isJson, IBrush key, IBrush value)
        {
            _isJson = isJson;
            _key = key;
            _value = value;
        }

        protected override void ColorizeLine(DocumentLine line)
        {
            if (!_isJson())
            {
                return;
            }

            var text = CurrentContext.Document.GetText(line);
            var stringSpans = new List<(int Start, int End)>();

            foreach (Match match in JsonStringPattern.Matches(text))
            {
                var brush = IsPropertyName(text, match.Index + match.Length) ? _key : _value;
                stringSpans.Add((match.Index, match.Index + match.Length));
                ChangeLinePart(
                    line.Offset + match.Index,
                    line.Offset + match.Index + match.Length,
                    element => element.TextRunProperties.SetForegroundBrush(brush));
            }

            foreach (Match match in JsonLiteralPattern.Matches(text))
            {
                if (stringSpans.Any(span => match.Index >= span.Start && match.Index < span.End))
                {
                    continue;
                }

                ChangeLinePart(
                    line.Offset + match.Index,
                    line.Offset + match.Index + match.Length,
                    element => element.TextRunProperties.SetForegroundBrush(_value));
            }
        }

        private static bool IsPropertyName(string line, int afterString)
        {
            for (var i = afterString; i < line.Length; i++)
            {
                if (char.IsWhiteSpace(line[i]))
                {
                    continue;
                }

                return line[i] == ':';
            }

            return false;
        }
    }

    /// <summary>Colors {{placeholder}} spans: amber (defined), grey (resolves but empty),
    /// or red (undefined).</summary>
    private sealed class VariableColorizer : DocumentColorizingTransformer
    {
        private readonly Func<string, VarHighlight> _state;
        private readonly IBrush _defined;
        private readonly IBrush _empty;
        private readonly IBrush _undefined;

        public VariableColorizer(Func<string, VarHighlight> state, IBrush defined, IBrush empty, IBrush undefined)
        {
            _state = state;
            _defined = defined;
            _empty = empty;
            _undefined = undefined;
        }

        protected override void ColorizeLine(DocumentLine line)
        {
            var text = CurrentContext.Document.GetText(line);
            foreach (Match match in PlaceholderPattern.Matches(text))
            {
                var brush = _state(match.Groups[1].Value) switch
                {
                    VarHighlight.Defined => _defined,
                    VarHighlight.Empty => _empty,
                    VarHighlight.Undefined => _undefined,
                    _ => null,
                };

                if (brush is null)
                {
                    continue;
                }

                ChangeLinePart(
                    line.Offset + match.Index,
                    line.Offset + match.Index + match.Length,
                    element => element.TextRunProperties.SetForegroundBrush(brush));
            }
        }
    }
}
