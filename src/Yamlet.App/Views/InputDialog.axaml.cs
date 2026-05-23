using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Markup.Xaml;

namespace Yamlet.App.Views;

/// <summary>A minimal modal text prompt returning the entered string, or null on cancel.</summary>
public partial class InputDialog : Window
{
    // Parameterless constructor required by the XAML loader / designer.
    public InputDialog() => InitializeComponent();

    public InputDialog(string title, string prompt, string defaultValue)
    {
        InitializeComponent();
        Title = title;
        PromptText.Text = prompt;
        InputBox.Text = defaultValue;

        Opened += (_, _) =>
        {
            InputBox.SelectAll();
            InputBox.Focus();
        };

        KeyDown += (_, e) =>
        {
            if (e.Key == Key.Escape)
            {
                Close(null);
            }
        };
    }

    private void InitializeComponent() => AvaloniaXamlLoader.Load(this);

    private void OnOk(object? sender, RoutedEventArgs e)
    {
        var text = InputBox.Text?.Trim();
        Close(string.IsNullOrWhiteSpace(text) ? null : text);
    }

    private void OnCancel(object? sender, RoutedEventArgs e) => Close(null);
}
