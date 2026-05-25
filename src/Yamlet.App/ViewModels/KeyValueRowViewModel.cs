using CommunityToolkit.Mvvm.ComponentModel;

namespace Yamlet.App.ViewModels;

/// <summary>
/// An editable key/value/description row used by the Params, Headers and Variables
/// grids. A row is "empty" when all text fields are blank, which the grid uses to
/// maintain a single trailing blank row for quick entry.
/// </summary>
public sealed partial class KeyValueRowViewModel : ViewModelBase
{
    public static readonly string[] FormDataValueTypes = { "Text", "File" };

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

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsTextValue))]
    [NotifyPropertyChangedFor(nameof(IsFileValue))]
    [NotifyPropertyChangedFor(nameof(ValuePlaceholder))]
    private bool _isFile;

    [ObservableProperty]
    private string _formDataValueType = "Text";

    public bool IsTextValue => !IsFile;

    public bool IsFileValue => IsFile;

    public string ValuePlaceholder => IsFile ? "Select a file" : "value";

    public bool IsEmpty =>
        string.IsNullOrWhiteSpace(Key) &&
        string.IsNullOrWhiteSpace(Value) &&
        string.IsNullOrWhiteSpace(Description);

    partial void OnIsFileChanged(bool value)
    {
        var type = value ? "File" : "Text";
        if (!string.Equals(FormDataValueType, type, StringComparison.Ordinal))
        {
            FormDataValueType = type;
        }
    }

    partial void OnFormDataValueTypeChanged(string value)
    {
        var isFile = string.Equals(value, "File", StringComparison.OrdinalIgnoreCase);
        if (IsFile != isFile)
        {
            IsFile = isFile;
        }
    }
}
