using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Markup.Xaml;

namespace Yamlet.App.Views;

/// <summary>A minimal modal text prompt returning the entered string, or null on cancel.</summary>
public partial class InputDialog : Window
{
    private TextBlock PromptTextControl => this.FindControl<TextBlock>("PromptText")
        ?? throw new InvalidOperationException("InputDialog is missing PromptText.");

    private TextBox InputBoxControl => this.FindControl<TextBox>("InputBox")
        ?? throw new InvalidOperationException("InputDialog is missing InputBox.");

    // Parameterless constructor required by the XAML loader / designer.
    public InputDialog() => InitializeComponent();

    public InputDialog(string title, string prompt, string defaultValue)
    {
        InitializeComponent();
        Title = title;
        PromptTextControl.Text = prompt;
        InputBoxControl.Text = defaultValue;

        Opened += (_, _) =>
        {
            InputBoxControl.SelectAll();
            InputBoxControl.Focus();
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
        var text = InputBoxControl.Text?.Trim();
        Close(string.IsNullOrWhiteSpace(text) ? null : text);
    }

    private void OnCancel(object? sender, RoutedEventArgs e) => Close(null);
}
