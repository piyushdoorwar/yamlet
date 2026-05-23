using CommunityToolkit.Mvvm.ComponentModel;

namespace Yamlet.App.ViewModels;

/// <summary>
/// An editable key/value/description row used by the Params, Headers and Variables
/// grids. A row is "empty" when all text fields are blank, which the grid uses to
/// maintain a single trailing blank row for quick entry.
/// </summary>
public sealed partial class KeyValueRowViewModel : ViewModelBase
{
    [ObservableProperty]
    private string _key = string.Empty;

    [ObservableProperty]
    private string _value = string.Empty;

    [ObservableProperty]
    private string _description = string.Empty;

    [ObservableProperty]
    private bool _enabled = true;

    [ObservableProperty]
    private bool _isReadOnly;

    public bool IsEmpty =>
        string.IsNullOrWhiteSpace(Key) &&
        string.IsNullOrWhiteSpace(Value) &&
        string.IsNullOrWhiteSpace(Description);
}
