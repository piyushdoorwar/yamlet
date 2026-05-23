using System.Text.Json;

namespace Yamlet.App.Stores;

/// <summary>
/// Persists the list of recently opened workspace paths to a small JSON file in the
/// user's application-data directory, most-recent first.
/// </summary>
public sealed class RecentWorkspaceService
{
    private const int MaxEntries = 10;

    private readonly string _storePath;

    public RecentWorkspaceService(string? storePath = null)
    {
        _storePath = storePath ?? DefaultStorePath();
    }

    private static string DefaultStorePath()
    {
        var baseDir = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var dir = Path.Combine(baseDir, "Yamlet");
        Directory.CreateDirectory(dir);
        return Path.Combine(dir, "recent-workspaces.json");
    }

    public List<string> Load()
    {
        try
        {
            if (!File.Exists(_storePath))
            {
                return new();
            }

            var json = File.ReadAllText(_storePath);
            return JsonSerializer.Deserialize<List<string>>(json) ?? new();
        }
        catch
        {
            return new();
        }
    }

    public void Add(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }

        var entries = Load();
        entries.RemoveAll(p => string.Equals(p, path, StringComparison.OrdinalIgnoreCase));
        entries.Insert(0, path);

        if (entries.Count > MaxEntries)
        {
            entries = entries.Take(MaxEntries).ToList();
        }

        try
        {
            File.WriteAllText(_storePath, JsonSerializer.Serialize(entries));
        }
        catch
        {
            // Best-effort persistence; ignore IO failures.
        }
    }
}
