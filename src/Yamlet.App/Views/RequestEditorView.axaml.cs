using System;
using System.ComponentModel;
using System.Linq;
using System.Text.RegularExpressions;
using Avalonia.Controls;
using Avalonia.Controls.Documents;
using Avalonia.Controls.Presenters;
using Avalonia.Controls.Primitives;
using Avalonia.Input;
using Avalonia.Input.Platform;
using Avalonia.Layout;
using Avalonia.Markup.Xaml;
using Avalonia.Media;
using Avalonia.VisualTree;
using Yamlet.App.Controls;
using Yamlet.App.Services;
using Yamlet.App.ViewModels;

namespace Yamlet.App.Views;

/// <summary>Editor for a single request, including the response panel.</summary>
public partial class RequestEditorView : UserControl
{
    private static readonly Regex PlaceholderPattern =
        new(@"\{\{\s*([^{}\s]+)\s*\}\}", RegexOptions.Compiled);

    private readonly Grid? _splitArea;
    private readonly Control? _requestPanel;
    private readonly GridSplitter? _splitter;
    private readonly Control? _responsePanel;
    private readonly TextBox? _urlBox;
    private readonly TextBlock? _urlHighlightText;
    private readonly IBrush _urlTextBrush;
    private readonly IBrush _urlDefinedBrush;
    private readonly IBrush _urlEmptyBrush;
    private readonly IBrush _urlUndefinedBrush;
    private RequestEditorViewModel? _viewModel;
    private IVariableSource? _urlVariableSource;
    private string _urlPeekVariable = string.Empty;

    public RequestEditorView()
    {
        AvaloniaXamlLoader.Load(this);
        _splitArea = this.FindControl<Grid>("SplitArea");
        _requestPanel = this.FindControl<Border>("RequestPanel");
        _splitter = this.FindControl<GridSplitter>("LayoutSplitter");
        _responsePanel = this.FindControl<Border>("ResponsePanel");
        _urlBox = this.FindControl<TextBox>("UrlBox");
        _urlHighlightText = this.FindControl<TextBlock>("UrlHighlightText");
        _urlTextBrush = FindBrush("TextPrimaryBrush", "#FFF5F4EF");
        _urlDefinedBrush = FindBrush("VariableDefinedBrush", "#FFE0A458");
        _urlEmptyBrush = FindBrush("TextMutedBrush", "#FF8A877D");
        _urlUndefinedBrush = FindBrush("VariableUndefinedBrush", "#FFE2655A");
        if (_urlHighlightText is not null)
        {
            _urlHighlightText.Inlines ??= new InlineCollection();
        }
        if (_urlBox is not null)
        {
            _urlBox.TextChanged += OnUrlTextChanged;
            _urlBox.PointerMoved += OnUrlPointerMoved;
            _urlBox.PointerExited += OnUrlPointerExited;
        }
        DataContextChanged += OnDataContextChanged;
    }

    // ---- URL variable hover peek -------------------------------------------

    private void OnUrlPointerMoved(object? sender, PointerEventArgs e)
    {
        if (DataContext is not IVariableSource source || _urlBox is null)
        {
            CloseUrlPeek();
            return;
        }

        var presenter = _urlBox.GetVisualDescendants().OfType<TextPresenter>().FirstOrDefault();
        if (presenter is null)
        {
            CloseUrlPeek();
            return;
        }

        var hit = presenter.TextLayout.HitTestPoint(e.GetPosition(presenter));
        var name = hit.IsInside ? VariableAtIndex(_urlBox.Text ?? string.Empty, hit.TextPosition) : null;
        if (name is null)
        {
            CloseUrlPeek();
            return;
        }

        if (string.Equals(name, _urlPeekVariable, StringComparison.Ordinal) &&
            this.FindControl<Popup>("UrlPeekPopup") is { IsOpen: true })
        {
            return;
        }

        ShowUrlPeek(source, name);
    }

    private void OnUrlPointerExited(object? sender, PointerEventArgs e) => CloseUrlPeek();

    private static string? VariableAtIndex(string text, int index)
    {
        foreach (Match match in PlaceholderPattern.Matches(text))
        {
            if (index >= match.Index && index <= match.Index + match.Length)
            {
                return match.Groups[1].Value;
            }
        }

        return null;
    }

    private void ShowUrlPeek(IVariableSource source, string name)
    {
        var nameText = this.FindControl<TextBlock>("UrlPeekName")!;
        var valueText = this.FindControl<TextBlock>("UrlPeekValue")!;
        var scopeText = this.FindControl<TextBlock>("UrlPeekScope")!;
        var popup = this.FindControl<Popup>("UrlPeekPopup")!;

        var defined = source.TryGetValue(name, out var value);
        nameText.Text = name;
        valueText.Text = defined
            ? (string.IsNullOrEmpty(value) ? "(empty)" : value)
            : "Not defined in any active scope.";
        scopeText.Text = defined ? $"Resolved with {source.TargetScopeName}" : string.Empty;

        popup.IsOpen = false;
        _urlPeekVariable = name;
        popup.IsOpen = true;
    }

    private void CloseUrlPeek()
    {
        _urlPeekVariable = string.Empty;
        if (this.FindControl<Popup>("UrlPeekPopup") is { } popup)
        {
            popup.IsOpen = false;
        }
    }

    private void OnUrlTextChanged(object? sender, TextChangedEventArgs e) => UpdateUrlHighlight();

    private void OnUrlVariablesChanged(object? sender, EventArgs e) => UpdateUrlHighlight();

    private void UpdateUrlHighlight()
    {
        if (_urlHighlightText is null)
        {
            return;
        }

        _urlHighlightText.Inlines?.Clear();

        var text = _urlBox?.Text ?? string.Empty;
        if (string.IsNullOrEmpty(text))
        {
            return;
        }

        var position = 0;
        foreach (Match match in PlaceholderPattern.Matches(text))
        {
            if (match.Index > position)
            {
                AddUrlRun(text[position..match.Index], null);
            }

            AddUrlRun(match.Value, UrlBrushForVariable(match.Groups[1].Value));
            position = match.Index + match.Length;
        }

        if (position < text.Length)
        {
            AddUrlRun(text[position..], null);
        }
    }

    private void AddUrlRun(string text, IBrush? brush)
    {
        if (_urlHighlightText?.Inlines is null || string.IsNullOrEmpty(text))
        {
            return;
        }

        _urlHighlightText.Inlines.Add(brush is null
            ? new Run(text)
            : new Run(text) { Foreground = brush });
    }

    private IBrush? UrlBrushForVariable(string name)
    {
        if (_urlVariableSource is not null && _urlVariableSource.TryGetValue(name, out var value))
        {
            return string.IsNullOrEmpty(value) ? _urlEmptyBrush : _urlDefinedBrush;
        }

        if (DynamicVariables.IsDynamic(name))
        {
            return _urlDefinedBrush;
        }

        return _urlVariableSource is null ? null : _urlUndefinedBrush;
    }

    private void OnDataContextChanged(object? sender, EventArgs e)
    {
        if (_viewModel is not null)
        {
            _viewModel.PropertyChanged -= OnViewModelPropertyChanged;
        }

        if (_urlVariableSource is not null)
        {
            _urlVariableSource.VariablesChanged -= OnUrlVariablesChanged;
        }

        _viewModel = DataContext as RequestEditorViewModel;
        _urlVariableSource = DataContext as IVariableSource;
        if (_viewModel is not null)
        {
            _viewModel.PropertyChanged += OnViewModelPropertyChanged;
            ApplyLayout(_viewModel.IsSideBySide);
        }
        if (_urlVariableSource is not null)
        {
            _urlVariableSource.VariablesChanged += OnUrlVariablesChanged;
        }

        UpdateUrlHighlight();
    }

    private void OnViewModelPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(RequestEditorViewModel.IsSideBySide) && _viewModel is not null)
        {
            ApplyLayout(_viewModel.IsSideBySide);
        }
    }

    private async void OnCopyResponseClicked(object? sender, Avalonia.Interactivity.RoutedEventArgs e)
    {
        if (_viewModel is null || !TryGetResponseTextToCopy(_viewModel, out var text))
        {
            return;
        }

        if (TopLevel.GetTopLevel(this)?.Clipboard is { } clipboard)
        {
            await clipboard.SetTextAsync(text);
        }
    }

    private static bool TryGetResponseTextToCopy(RequestEditorViewModel viewModel, out string text)
    {
        text = viewModel.SelectedResponseView switch
        {
            "Headers" => viewModel.ResponseHeadersText,
            "Raw" => viewModel.ResponseRaw,
            "Console" => viewModel.ResponseConsole,
            _ => viewModel.ResponseBody,
        };

        return !string.IsNullOrEmpty(text);
    }

    /// <summary>
    /// Reconfigures the split grid so the response panel sits either beside the request
    /// (side-by-side columns) or stacked below it (rows), repositioning the divider.
    /// </summary>
    private void ApplyLayout(bool sideBySide)
    {
        if (_splitArea is null || _requestPanel is null || _splitter is null || _responsePanel is null)
        {
            return;
        }

        if (sideBySide)
        {
            _splitArea.RowDefinitions = new RowDefinitions("*");
            _splitArea.ColumnDefinitions = new ColumnDefinitions("*,Auto,*");

            Grid.SetRow(_requestPanel, 0);
            Grid.SetColumn(_requestPanel, 0);
            Grid.SetRow(_splitter, 0);
            Grid.SetColumn(_splitter, 1);
            Grid.SetRow(_responsePanel, 0);
            Grid.SetColumn(_responsePanel, 2);

            _splitter.Width = 6;
            _splitter.Height = double.NaN;
            _splitter.HorizontalAlignment = HorizontalAlignment.Center;
            _splitter.VerticalAlignment = VerticalAlignment.Stretch;
            _splitter.ResizeDirection = GridResizeDirection.Columns;
        }
        else
        {
            _splitArea.ColumnDefinitions = new ColumnDefinitions("*");
            _splitArea.RowDefinitions = new RowDefinitions("*,Auto,*");

            Grid.SetColumn(_requestPanel, 0);
            Grid.SetRow(_requestPanel, 0);
            Grid.SetColumn(_splitter, 0);
            Grid.SetRow(_splitter, 1);
            Grid.SetColumn(_responsePanel, 0);
            Grid.SetRow(_responsePanel, 2);

            _splitter.Height = 6;
            _splitter.Width = double.NaN;
            _splitter.HorizontalAlignment = HorizontalAlignment.Stretch;
            _splitter.VerticalAlignment = VerticalAlignment.Center;
            _splitter.ResizeDirection = GridResizeDirection.Rows;
        }
    }

    private static IBrush FindBrush(string key, string fallbackHex)
    {
        if (Avalonia.Application.Current is { } app &&
            app.TryGetResource(key, app.ActualThemeVariant, out var value) &&
            value is IBrush brush)
        {
            return brush;
        }

        return new SolidColorBrush(Color.Parse(fallbackHex));
    }
}
