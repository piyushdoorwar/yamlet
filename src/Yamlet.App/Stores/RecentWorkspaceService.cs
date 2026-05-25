using System.Text.Json;
using Yamlet.App.Models;

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

    public YamletResponse? LoadLastResponse(string workspaceRootPath, string requestKey)
    {
        if (string.IsNullOrWhiteSpace(workspaceRootPath) || string.IsNullOrWhiteSpace(requestKey))
        {
            return null;
        }

        var state = LoadState();
        return state.LastResponseByWorkspace.TryGetValue(NormalizePath(workspaceRootPath), out var responses) &&
               responses.TryGetValue(NormalizePath(requestKey), out var response)
            ? CloneForUi(response)
            : null;
    }

    public void RememberLastResponse(string workspaceRootPath, string requestKey, YamletResponse response)
    {
        if (string.IsNullOrWhiteSpace(workspaceRootPath) || string.IsNullOrWhiteSpace(requestKey))
        {
            return;
        }

        var state = LoadState();
        var workspaceKey = NormalizePath(workspaceRootPath);
        if (!state.LastResponseByWorkspace.TryGetValue(workspaceKey, out var responses))
        {
            responses = new Dictionary<string, YamletResponse>(StringComparer.OrdinalIgnoreCase);
            state.LastResponseByWorkspace[workspaceKey] = responses;
        }

        responses[NormalizePath(requestKey)] = CloneForCache(response);
        SaveState(state);
    }

    /// <summary>Loads the saved open-tab session for a workspace (empty if none).</summary>
    public WorkspaceSession LoadSession(string workspaceRootPath)
    {
        if (string.IsNullOrWhiteSpace(workspaceRootPath))
        {
            return new WorkspaceSession();
        }

        var state = LoadState();
        return state.SessionByWorkspace.TryGetValue(NormalizePath(workspaceRootPath), out var session)
            ? session
            : new WorkspaceSession();
    }

    public void SaveSession(string workspaceRootPath, WorkspaceSession session)
    {
        if (string.IsNullOrWhiteSpace(workspaceRootPath))
        {
            return;
        }

        var state = LoadState();
        state.SessionByWorkspace[NormalizePath(workspaceRootPath)] = session;
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
            state.SessionByWorkspace ??= new(StringComparer.OrdinalIgnoreCase);
            state.LastResponseByWorkspace ??= new(StringComparer.OrdinalIgnoreCase);
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

    private static YamletResponse CloneForCache(YamletResponse response) => new()
    {
        StatusCode = response.StatusCode,
        ReasonPhrase = response.ReasonPhrase,
        DurationMs = response.DurationMs,
        SizeBytes = response.SizeBytes,
        Headers = response.Headers.Select(h => new YamletHeader
        {
            Key = h.Key,
            Value = h.Value,
            Description = h.Description,
            Enabled = h.Enabled,
        }).ToList(),
        Body = response.Body,
        ContentType = response.ContentType,
        IsError = response.IsError,
        ErrorMessage = response.ErrorMessage,
        ConsoleText = string.Empty,
    };

    private static YamletResponse CloneForUi(YamletResponse response) => CloneForCache(response);

    private sealed class CacheState
    {
        public List<string> RecentWorkspaces { get; set; } = new();
        public Dictionary<string, string> SelectedEnvironmentByWorkspace { get; set; } = new(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, WorkspaceSession> SessionByWorkspace { get; set; } = new(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, Dictionary<string, YamletResponse>> LastResponseByWorkspace { get; set; } = new(StringComparer.OrdinalIgnoreCase);
        public bool ResponseSideBySide { get; set; }
    }
}

/// <summary>The set of editor tabs open for a workspace, plus which one was active.</summary>
public sealed class WorkspaceSession
{
    public List<OpenTabRef> OpenTabs { get; set; } = new();
    public int ActiveTabIndex { get; set; } = -1;
}

/// <summary>A persisted reference to one open tab, by kind and a stable disk-derived key.</summary>
public sealed class OpenTabRef
{
    /// <summary>"request", "environment", or "collection".</summary>
    public string Kind { get; set; } = string.Empty;

    /// <summary>Stable identifier: source file path for requests/collections, file path or name for environments.</summary>
    public string Key { get; set; } = string.Empty;
}
