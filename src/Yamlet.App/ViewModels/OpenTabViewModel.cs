using System;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace Yamlet.App.ViewModels;

/// <summary>What kind of editor a tab hosts, used to pick its header marker.</summary>
public enum OpenTabKind
{
    Request,
    Environment,
    Collection,
}

/// <summary>
/// One open editor tab in the main work area. Wraps a content view model
/// (request editor, environment editor, …) plus the header metadata and the
/// activate/close commands the tab strip binds to.
/// </summary>
public sealed partial class OpenTabViewModel : ViewModelBase
{
    private readonly Action<OpenTabViewModel> _activate;
    private readonly Action<OpenTabViewModel> _close;

    public OpenTabViewModel(
        object key,
        object content,
        OpenTabKind kind,
        string title,
        Action<OpenTabViewModel> activate,
        Action<OpenTabViewModel> close,
        string method = "GET")
    {
        Key = key;
        Content = content;
        Kind = kind;
        _title = title;
        _method = method;
        _activate = activate;
        _close = close;
    }

    /// <summary>Identity used to find an already-open tab (the node or environment).</summary>
    public object Key { get; }

    /// <summary>The hosted editor view model, rendered via the window's data templates.</summary>
    public object Content { get; }

    public OpenTabKind Kind { get; }

    [ObservableProperty]
    private bool _isActive;

    [ObservableProperty]
    private string _title;

    [ObservableProperty]
    private string _method;

    public bool IsRequest => Kind == OpenTabKind.Request;
    public bool IsEnvironment => Kind == OpenTabKind.Environment;
    public bool IsCollection => Kind == OpenTabKind.Collection;

    public string MethodLabel => FormatMethod(Method);

    partial void OnMethodChanged(string value) => OnPropertyChanged(nameof(MethodLabel));

    private static string FormatMethod(string? method)
    {
        var normalized = string.IsNullOrWhiteSpace(method) ? "GET" : method.ToUpperInvariant();
        return normalized == "DELETE" ? "DEL" : normalized;
    }

    [RelayCommand]
    private void Activate() => _activate(this);

    [RelayCommand]
    private void Close() => _close(this);
}
