using System;
using System.ComponentModel;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Markup.Xaml;
using Yamlet.App.ViewModels;

namespace Yamlet.App.Views;

/// <summary>Editor for a single request, including the response panel.</summary>
public partial class RequestEditorView : UserControl
{
    private readonly Grid? _splitArea;
    private readonly Control? _requestPanel;
    private readonly GridSplitter? _splitter;
    private readonly Control? _responsePanel;
    private RequestEditorViewModel? _viewModel;

    public RequestEditorView()
    {
        AvaloniaXamlLoader.Load(this);
        _splitArea = this.FindControl<Grid>("SplitArea");
        _requestPanel = this.FindControl<Border>("RequestPanel");
        _splitter = this.FindControl<GridSplitter>("LayoutSplitter");
        _responsePanel = this.FindControl<Border>("ResponsePanel");
        DataContextChanged += OnDataContextChanged;
    }

    private void OnDataContextChanged(object? sender, EventArgs e)
    {
        if (_viewModel is not null)
        {
            _viewModel.PropertyChanged -= OnViewModelPropertyChanged;
        }

        _viewModel = DataContext as RequestEditorViewModel;
        if (_viewModel is not null)
        {
            _viewModel.PropertyChanged += OnViewModelPropertyChanged;
            ApplyLayout(_viewModel.IsSideBySide);
        }
    }

    private void OnViewModelPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(RequestEditorViewModel.IsSideBySide) && _viewModel is not null)
        {
            ApplyLayout(_viewModel.IsSideBySide);
        }
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
            _splitArea.ColumnDefinitions = new ColumnDefinitions("*,Auto,1.3*");

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
            _splitArea.RowDefinitions = new RowDefinitions("2*,Auto,1.3*");

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
}
