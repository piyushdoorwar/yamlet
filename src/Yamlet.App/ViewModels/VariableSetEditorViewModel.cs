using Yamlet.App.Models;

namespace Yamlet.App.ViewModels;

/// <summary>
/// Edits a flat set of variables (an environment, or the workspace globals) in an
/// editable key/value/enabled grid. Changes auto-save after a short debounce.
/// </summary>
public sealed partial class VariableSetEditorViewModel : ViewModelBase
{
    private readonly List<YamletVariable> _target;
    private readonly Func<Task> _save;
    private readonly Action<string>? _status;
    private CancellationTokenSource? _autoSaveCts;

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

        // Subscribe after Load so initial population doesn't trigger auto-save.
        Rows.ContentChanged += (_, _) => ScheduleAutoSave();
    }

    private async void ScheduleAutoSave()
    {
        // Sync live variables immediately so {{placeholders}} resolve correctly while typing.
        SyncTarget();

        var prev = _autoSaveCts;
        _autoSaveCts = new CancellationTokenSource();
        prev?.Cancel();
        prev?.Dispose();
        try
        {
            await Task.Delay(800, _autoSaveCts.Token).ConfigureAwait(false);
            await _save().ConfigureAwait(false);
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            _status?.Invoke($"Auto-save failed: {ex.Message}");
        }
    }

    private void SyncTarget()
    {
        _target.Clear();
        foreach (var row in Rows.NonEmptyRows())
        {
            _target.Add(new YamletVariable { Key = row.Key, Value = row.Value, Enabled = row.Enabled });
        }
    }
}
