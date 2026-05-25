using System.Collections.ObjectModel;
using System.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace Yamlet.App.ViewModels;

/// <summary>
/// Manages a collection of <see cref="KeyValueRowViewModel"/> with a single trailing
/// blank row: typing into the blank row spawns a fresh one, and clearing a row removes
/// it. This mirrors the quick-entry grids common to API clients.
/// </summary>
public sealed partial class EditableRowsViewModel : ViewModelBase
{
    public ObservableCollection<KeyValueRowViewModel> Rows { get; } = new();

    private bool _suppressMaintenance;

    public EditableRowsViewModel()
    {
        AppendBlankRow();
    }

    /// <summary>Replaces all rows with the supplied set and re-adds a trailing blank row.</summary>
    public void Load(IEnumerable<KeyValueRowViewModel> rows)
    {
        _suppressMaintenance = true;
        foreach (var existing in Rows)
        {
            existing.PropertyChanged -= OnRowChanged;
        }
        Rows.Clear();

        foreach (var row in rows)
        {
            row.PropertyChanged += OnRowChanged;
            Rows.Add(row);
        }
        _suppressMaintenance = false;

        AppendBlankRow();
    }

    /// <summary>Returns the non-empty rows in order, suitable for mapping to the model.</summary>
    public IEnumerable<KeyValueRowViewModel> NonEmptyRows() => Rows.Where(r => !r.IsEmpty);

    [RelayCommand]
    private void RemoveRow(KeyValueRowViewModel row)
    {
        if (row.IsReadOnly || !Rows.Contains(row))
        {
            return;
        }

        row.PropertyChanged -= OnRowChanged;
        Rows.Remove(row);

        if (Rows.Count == 0 || !Rows[^1].IsEmpty)
        {
            AppendBlankRow();
        }

        ContentChanged?.Invoke(this, EventArgs.Empty);
    }

    private void AppendBlankRow()
    {
        var row = new KeyValueRowViewModel();
        row.PropertyChanged += OnRowChanged;
        Rows.Add(row);
    }

    /// <summary>Raised when any row's content changes or a row is removed.</summary>
    public event EventHandler? ContentChanged;

    private void OnRowChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (_suppressMaintenance || sender is not KeyValueRowViewModel)
        {
            return;
        }

        // Keep exactly one trailing blank row: if the last row gained content, add a
        // new blank beneath it so there is always somewhere to type.
        if (Rows.Count > 0 && !Rows[^1].IsEmpty)
        {
            AppendBlankRow();
        }

        ContentChanged?.Invoke(this, EventArgs.Empty);
    }
}
