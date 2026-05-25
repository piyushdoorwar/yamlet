using Avalonia.Controls;
using Avalonia.Platform.Storage;
using Yamlet.App.Views;

namespace Yamlet.App.Services;

/// <summary>
/// Abstracts the platform folder/file pickers and simple prompts so view models stay
/// testable and free of direct Avalonia window references.
/// </summary>
public interface IDialogService
{
    Task<string?> PickFolderAsync(string title);

    Task<string?> PickFileAsync(string title);

    /// <summary>
    /// Shows a single-line text prompt. Returns the entered text, or null if cancelled.
    /// </summary>
    Task<string?> PromptTextAsync(string title, string prompt, string defaultValue = "");
}

/// <summary>
/// <see cref="IDialogService"/> backed by Avalonia. The owning window is supplied by
/// the main window once it is constructed and is used for picker ownership.
/// </summary>
public sealed class DialogService : IDialogService
{
    private Window? _owner;

    public void Attach(Window owner) => _owner = owner;

    public async Task<string?> PickFolderAsync(string title)
    {
        if (_owner?.StorageProvider is not { } storage)
        {
            return null;
        }

        var folders = await storage.OpenFolderPickerAsync(new FolderPickerOpenOptions
        {
            Title = title,
            AllowMultiple = false,
        });

        var folder = folders.Count > 0 ? folders[0] : null;
        return folder?.TryGetLocalPath();
    }

    public async Task<string?> PickFileAsync(string title)
    {
        if (_owner?.StorageProvider is not { } storage)
        {
            return null;
        }

        var files = await storage.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            Title = title,
            AllowMultiple = false,
        });

        var file = files.Count > 0 ? files[0] : null;
        return file?.TryGetLocalPath();
    }

    public async Task<string?> PromptTextAsync(string title, string prompt, string defaultValue = "")
    {
        if (_owner is null)
        {
            return null;
        }

        var dialog = new InputDialog(title, prompt, defaultValue);
        return await dialog.ShowDialog<string?>(_owner);
    }
}
