using CommunityToolkit.Mvvm.Input;
using Yamlet.App.Models;

namespace Yamlet.App.ViewModels;

/// <summary>
/// Edits a flat set of variables (an environment, or the workspace globals) in an
/// editable key/value/enabled grid. On save it writes the rows back into the target
/// list and invokes the supplied persistence delegate.
/// </summary>
public sealed partial class VariableSetEditorViewModel : ViewModelBase
{
    private readonly List<YamletVariable> _target;
    private readonly Func<Task> _save;
    private readonly Action<string>? _status;

    public string Title { get; }
    public string Subtitle { get; }
    public EditableRowsViewModel Rows { get; } = new();

    public VariableSetEditorViewModel(
        string title,
        string subtitle,
        List<YamletVariable> target,
        Func<Task> save,
        Action<string>? status = null)
    {
        Title = title;
        Subtitle = subtitle;
        _target = target;
        _save = save;
        _status = status;

        Rows.Load(target.Select(v => new KeyValueRowViewModel
        {
            Key = v.Key, Value = v.Value, Enabled = v.Enabled,
        }));
    }

    [RelayCommand]
    private async Task SaveAsync()
    {
        // Mutate the target list in place so the workspace's live variables (used when
        // resolving {{placeholders}}) reflect the edits immediately.
        _target.Clear();
        foreach (var row in Rows.NonEmptyRows())
        {
            _target.Add(new YamletVariable { Key = row.Key, Value = row.Value, Enabled = row.Enabled });
        }

        try
        {
            await _save();
            _status?.Invoke($"Saved {Title}");
        }
        catch (Exception ex)
        {
            _status?.Invoke($"Save failed: {ex.Message}");
        }
    }
}
