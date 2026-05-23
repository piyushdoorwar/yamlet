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
using AvaloniaEdit.Document;
using AvaloniaEdit.Folding;
using AvaloniaEdit.Rendering;

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

    private readonly TextEditor _editor;
    private readonly IBrush _definedBrush;
    private readonly IBrush _undefinedBrush;
    private readonly JsonFoldingStrategy _foldingStrategy = new();
    private FoldingManager? _foldingManager;
    private bool _syncing;
    private IVariableSource? _subscribed;
    private string _popupVariable = string.Empty;
    private string _peekVariable = string.Empty;

    public CodeEditorView()
    {
        AvaloniaXamlLoader.Load(this);

        _definedBrush = FindBrush("VariableDefinedBrush", "#FFE0A458");
        _undefinedBrush = FindBrush("VariableUndefinedBrush", "#FFE2655A");

        _editor = this.FindControl<TextEditor>("EditorBox")!;
        _editor.Text = Text ?? string.Empty;
        _editor.TextChanged += OnEditorTextChanged;
        _editor.TextArea.TextView.LineTransformers.Add(new VariableColorizer(VariableState, _definedBrush, _undefinedBrush));
        _editor.AddHandler(PointerPressedEvent, OnEditorPointerPressed, Avalonia.Interactivity.RoutingStrategies.Tunnel, handledEventsToo: true);
        _editor.TextArea.TextView.PointerMoved += OnEditorPointerMoved;
        _editor.TextArea.TextView.PointerExited += OnEditorPointerExited;
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
            _foldingManager ??= FoldingManager.Install(_editor.TextArea);
            _foldingStrategy.UpdateFoldings(_foldingManager, _editor.Document);
        }
        else if (_foldingManager is not null)
        {
            FoldingManager.Uninstall(_foldingManager);
            _foldingManager = null;
        }
    }

    // ---- Variable inspector --------------------------------------------------

    private bool? VariableState(string name)
    {
        var source = VariableSource;
        if (source is null)
        {
            return null;
        }

        return source.TryGetValue(name, out _);
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
        if (VariableSource is null)
        {
            ClosePeek();
            return;
        }

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
        if (source is null)
        {
            return;
        }

        var nameText = this.FindControl<TextBlock>("PeekNameText")!;
        var valueText = this.FindControl<TextBlock>("PeekValueText")!;
        var scopeText = this.FindControl<TextBlock>("PeekScopeText")!;
        var popup = this.FindControl<Popup>("VarPeekPopup")!;

        var defined = source.TryGetValue(name, out var value);
        nameText.Text = name;
        nameText.Foreground = defined ? _definedBrush : _undefinedBrush;
        valueText.Text = defined
            ? (string.IsNullOrEmpty(value) ? "(empty)" : value)
            : "Not defined in any active scope.";
        scopeText.Text = defined ? $"Resolved with {source.TargetScopeName}" : string.Empty;

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
        nameText.Foreground = defined ? _definedBrush : _undefinedBrush;
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

    /// <summary>Colors {{placeholder}} spans amber (defined) or red (undefined).</summary>
    private sealed class VariableColorizer : DocumentColorizingTransformer
    {
        private readonly Func<string, bool?> _state;
        private readonly IBrush _defined;
        private readonly IBrush _undefined;

        public VariableColorizer(Func<string, bool?> state, IBrush defined, IBrush undefined)
        {
            _state = state;
            _defined = defined;
            _undefined = undefined;
        }

        protected override void ColorizeLine(DocumentLine line)
        {
            var text = CurrentContext.Document.GetText(line);
            foreach (Match match in PlaceholderPattern.Matches(text))
            {
                var state = _state(match.Groups[1].Value);
                if (state is null)
                {
                    continue;
                }

                var brush = state.Value ? _defined : _undefined;
                ChangeLinePart(
                    line.Offset + match.Index,
                    line.Offset + match.Index + match.Length,
                    element => element.TextRunProperties.SetForegroundBrush(brush));
            }
        }
    }
}
