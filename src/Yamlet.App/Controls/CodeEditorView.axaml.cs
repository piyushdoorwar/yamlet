using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Markup.Xaml;

namespace Yamlet.App.Controls;

/// <summary>A compact code editor with line numbers and JSON formatting.</summary>
public partial class CodeEditorView : UserControl
{
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

    public CodeEditorView()
    {
        AvaloniaXamlLoader.Load(this);
        UpdateLineNumbers();
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

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);
        if (change.Property == TextProperty)
        {
            UpdateLineNumbers();
        }
    }

    private void OnEditorTextChanged(object? sender, TextChangedEventArgs e) => UpdateLineNumbers();

    private void OnBeautifyClicked(object? sender, Avalonia.Interactivity.RoutedEventArgs e)
    {
        if (!TryBeautifyJson(Text, out var formatted))
        {
            return;
        }

        Text = formatted;
    }

    private void UpdateLineNumbers()
    {
        var lineNumbers = this.FindControl<TextBlock>("LineNumbers");
        if (lineNumbers is null)
        {
            return;
        }

        var text = Text ?? string.Empty;
        var lines = Math.Max(1, text.Count(c => c == '\n') + 1);
        lineNumbers.Text = string.Join('\n', Enumerable.Range(1, lines));
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
}
