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
        return LoadState().RecentWorkspaces;
    }

    public string? LoadSelectedEnvironmentId(string workspaceRootPath)
    {
        if (string.IsNullOrWhiteSpace(workspaceRootPath))
        {
            return null;
        }

        var state = LoadState();
        return state.SelectedEnvironmentByWorkspace.TryGetValue(NormalizePath(workspaceRootPath), out var environmentId)
            ? environmentId
            : null;
    }

    /// <summary>
    /// Whether the request editor shows the response beside the request (side-by-side)
    /// rather than stacked below it. A global UI preference, not workspace-specific.
    /// </summary>
    public bool LoadResponseSideBySide() => LoadState().ResponseSideBySide;

    public void RememberResponseSideBySide(bool sideBySide)
    {
        var state = LoadState();
        state.ResponseSideBySide = sideBySide;
        SaveState(state);
    }

    public void RememberSelectedEnvironment(string workspaceRootPath, string environmentId)
    {
        if (string.IsNullOrWhiteSpace(workspaceRootPath) || string.IsNullOrWhiteSpace(environmentId))
        {
            return;
        }

        var state = LoadState();
        state.SelectedEnvironmentByWorkspace[NormalizePath(workspaceRootPath)] = environmentId;
        SaveState(state);
    }

    private CacheState LoadState()
    {
        try
        {
            if (!File.Exists(_storePath))
            {
                return new CacheState();
            }

            var json = File.ReadAllText(_storePath);
            if (string.IsNullOrWhiteSpace(json))
            {
                return new CacheState();
            }

            if (json.TrimStart().StartsWith('['))
            {
                return new CacheState
                {
                    RecentWorkspaces = JsonSerializer.Deserialize<List<string>>(json) ?? new(),
                };
            }

            var state = JsonSerializer.Deserialize<CacheState>(json) ?? new CacheState();
            state.RecentWorkspaces ??= new();
            state.SelectedEnvironmentByWorkspace ??= new(StringComparer.OrdinalIgnoreCase);
            return state;
        }
        catch
        {
            return new CacheState();
        }
    }

    public void Add(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }

        var state = LoadState();
        state.RecentWorkspaces.RemoveAll(p => string.Equals(p, path, StringComparison.OrdinalIgnoreCase));
        state.RecentWorkspaces.Insert(0, path);

        if (state.RecentWorkspaces.Count > MaxEntries)
        {
            state.RecentWorkspaces = state.RecentWorkspaces.Take(MaxEntries).ToList();
        }

        SaveState(state);
    }

    private void SaveState(CacheState state)
    {
        try
        {
            File.WriteAllText(_storePath, JsonSerializer.Serialize(state));
        }
        catch
        {
            // Best-effort persistence; ignore IO failures.
        }
    }

    private static string NormalizePath(string path)
    {
        try
        {
            return Path.GetFullPath(path);
        }
        catch
        {
            return path;
        }
    }

    private sealed class CacheState
    {
        public List<string> RecentWorkspaces { get; set; } = new();
        public Dictionary<string, string> SelectedEnvironmentByWorkspace { get; set; } = new(StringComparer.OrdinalIgnoreCase);
        public bool ResponseSideBySide { get; set; }
    }
}
