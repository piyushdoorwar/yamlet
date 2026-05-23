using Yamlet.App.Models;

namespace Yamlet.App.Services;

/// <summary>
/// Creates and opens Yamlet workspaces on disk. A workspace lives in a <c>yamlet/</c>
/// directory containing <c>collections/</c>, <c>environments/</c> and <c>globals/</c>.
/// </summary>
public sealed class WorkspaceService
{
    public const string RootDirName = "yamlet";
    public const string CollectionsDirName = "collections";
    public const string EnvironmentsDirName = "environments";
    public const string GlobalsDirName = "globals";
    public const string GlobalsFileName = "globals.yaml";

    private readonly YamlSerializationService _yaml;
    private readonly CollectionService _collections;

    public WorkspaceService(YamlSerializationService yaml, CollectionService collections)
    {
        _yaml = yaml;
        _collections = collections;
    }

    /// <summary>
    /// Resolves the <c>yamlet/</c> root directory for a path the user selected. If the
    /// selection already looks like a workspace root it is used directly; otherwise a
    /// <c>yamlet/</c> sub-directory of the selection is used.
    /// </summary>
    public static string ResolveRoot(string selectedPath)
    {
        if (LooksLikeRoot(selectedPath) ||
            string.Equals(Path.GetFileName(selectedPath.TrimEnd(Path.DirectorySeparatorChar)), RootDirName, StringComparison.OrdinalIgnoreCase))
        {
            return selectedPath;
        }

        return Path.Combine(selectedPath, RootDirName);
    }

    private static bool LooksLikeRoot(string path) =>
        Directory.Exists(Path.Combine(path, CollectionsDirName)) &&
        Directory.Exists(Path.Combine(path, EnvironmentsDirName));

    /// <summary>Ensures the workspace folder skeleton exists, creating any missing pieces.</summary>
    public async Task EnsureWorkspaceStructureAsync(string root)
    {
        Directory.CreateDirectory(Path.Combine(root, CollectionsDirName));
        Directory.CreateDirectory(Path.Combine(root, EnvironmentsDirName));
        var globalsDir = Path.Combine(root, GlobalsDirName);
        Directory.CreateDirectory(globalsDir);

        var globalsFile = Path.Combine(globalsDir, GlobalsFileName);
        if (!File.Exists(globalsFile))
        {
            var seed = new GlobalsDto
            {
                Variables = new() { new KeyValueDto { Key = "appName", Value = "Yamlet", Enabled = true } },
            };
            await File.WriteAllTextAsync(globalsFile, _yaml.Serialize(seed)).ConfigureAwait(false);
        }
    }

    public async Task<YamletWorkspace> CreateWorkspaceAsync(string selectedPath)
    {
        var root = ResolveRoot(selectedPath);
        await EnsureWorkspaceStructureAsync(root).ConfigureAwait(false);
        return await OpenWorkspaceAsync(selectedPath).ConfigureAwait(false);
    }

    public async Task<YamletWorkspace> OpenWorkspaceAsync(string selectedPath)
    {
        var root = ResolveRoot(selectedPath);
        await EnsureWorkspaceStructureAsync(root).ConfigureAwait(false);

        var workspace = new YamletWorkspace
        {
            RootPath = root,
            Name = Path.GetFileName(Path.GetDirectoryName(root.TrimEnd(Path.DirectorySeparatorChar)) ?? root) is { Length: > 0 } parent
                ? parent
                : RootDirName,
            CollectionsPath = Path.Combine(root, CollectionsDirName),
            EnvironmentsPath = Path.Combine(root, EnvironmentsDirName),
            GlobalsPath = Path.Combine(root, GlobalsDirName),
        };

        workspace.Collections = await _collections.LoadCollectionsAsync(workspace).ConfigureAwait(false);
        workspace.Environments = await LoadEnvironmentsAsync(workspace).ConfigureAwait(false);
        workspace.Globals = await LoadGlobalsAsync(workspace).ConfigureAwait(false);
        return workspace;
    }

    public async Task<List<YamletEnvironment>> LoadEnvironmentsAsync(YamletWorkspace workspace)
    {
        var result = new List<YamletEnvironment>();
        if (!Directory.Exists(workspace.EnvironmentsPath))
        {
            return result;
        }

        foreach (var file in Directory.EnumerateFiles(workspace.EnvironmentsPath, "*.yaml").OrderBy(f => f))
        {
            try
            {
                var dto = _yaml.Deserialize<EnvironmentDto>(await File.ReadAllTextAsync(file).ConfigureAwait(false));
                if (string.IsNullOrWhiteSpace(dto.Name))
                {
                    dto.Name = Path.GetFileNameWithoutExtension(file);
                }
                result.Add(dto.ToDomain(file));
            }
            catch
            {
                // Skip malformed environment files rather than failing the whole open.
            }
        }

        return result;
    }

    public async Task<List<YamletVariable>> LoadGlobalsAsync(YamletWorkspace workspace)
    {
        var file = Path.Combine(workspace.GlobalsPath, GlobalsFileName);
        if (!File.Exists(file))
        {
            return new();
        }

        try
        {
            var dto = _yaml.Deserialize<GlobalsDto>(await File.ReadAllTextAsync(file).ConfigureAwait(false));
            return dto.ToDomain();
        }
        catch
        {
            return new();
        }
    }
}
