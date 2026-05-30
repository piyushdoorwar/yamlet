using Yamlet.App.Models;

namespace Yamlet.App.Services;

/// <summary>
/// Manages collections on disk. A collection is a directory under
/// <c>collections/</c> holding a <c>collection.yaml</c> metadata file, request
/// <c>.yaml</c> files, and sub-directories for folders (recursively).
/// </summary>
public sealed class CollectionService
{
    public const string MetadataFileName = "collection.yaml";
    public const string FolderMetadataFileName = "folder.yaml";

    private readonly YamlSerializationService _yaml;
    private readonly RequestFileService _requestFiles;

    public CollectionService(YamlSerializationService yaml, RequestFileService requestFiles)
    {
        _yaml = yaml;
        _requestFiles = requestFiles;
    }

    // ---- Loading -----------------------------------------------------------

    public async Task<List<YamletCollection>> LoadCollectionsAsync(YamletWorkspace workspace)
    {
        var result = new List<YamletCollection>();
        if (!Directory.Exists(workspace.CollectionsPath))
        {
            return result;
        }

        foreach (var dir in Directory.EnumerateDirectories(workspace.CollectionsPath).OrderBy(d => d))
        {
            try
            {
                result.Add(await LoadCollectionAsync(dir).ConfigureAwait(false));
            }
            catch
            {
                // Skip unreadable collections instead of failing the whole workspace open.
            }
        }

        // Honor the persisted collection order; ties fall back to the alphabetical
        // enumeration order above (OrderBy is stable).
        return result.OrderBy(c => c.Order).ToList();
    }

    private async Task<YamletCollection> LoadCollectionAsync(string directory)
    {
        var collection = new YamletCollection
        {
            DirectoryPath = directory,
            Name = Path.GetFileName(directory),
        };

        // Exported tools store collection metadata (variables, auth incl. OAuth2,
        // collection-scope scripts) under .resources/definition.yaml. Apply it first so a
        // native collection.yaml, if present, can override the parts it specifies.
        var definitionPath = Path.Combine(directory, ".resources", "definition.yaml");
        if (File.Exists(definitionPath))
        {
            var definition = _yaml.Deserialize<CollectionDefinitionDto>(
                await File.ReadAllTextAsync(definitionPath).ConfigureAwait(false));
            definition.ApplyTo(collection);
        }

        var metadataPath = Path.Combine(directory, MetadataFileName);
        collection.FilePath = metadataPath;
        if (File.Exists(metadataPath))
        {
            var dto = _yaml.Deserialize<CollectionMetadataDto>(await File.ReadAllTextAsync(metadataPath).ConfigureAwait(false));
            dto.ApplyTo(collection);
        }

        collection.Requests = await LoadRequestsInDirectoryAsync(directory).ConfigureAwait(false);
        collection.Folders = await LoadFoldersAsync(directory).ConfigureAwait(false);
        return collection;
    }

    private async Task<List<YamletFolder>> LoadFoldersAsync(string parentDir)
    {
        var folders = new List<YamletFolder>();
        foreach (var dir in Directory.EnumerateDirectories(parentDir).OrderBy(d => d))
        {
            // Skip hidden / tooling directories such as ".resources" or ".git".
            if (Path.GetFileName(dir).StartsWith('.'))
            {
                continue;
            }

            var folder = new YamletFolder
            {
                Name = Path.GetFileName(dir),
                DirectoryPath = dir,
                Requests = await LoadRequestsInDirectoryAsync(dir).ConfigureAwait(false),
                Folders = await LoadFoldersAsync(dir).ConfigureAwait(false),
            };

            // folder.yaml carries the folder's display name and persisted position.
            var metadataPath = Path.Combine(dir, FolderMetadataFileName);
            if (File.Exists(metadataPath))
            {
                try
                {
                    var dto = _yaml.Deserialize<FolderDto>(
                        await File.ReadAllTextAsync(metadataPath).ConfigureAwait(false));
                    dto.ApplyTo(folder);
                }
                catch
                {
                    // Ignore a malformed folder.yaml; fall back to the directory name + order 0.
                }
            }

            folders.Add(folder);
        }

        // Honor the persisted order; ties keep the alphabetical enumeration order (stable sort).
        return folders.OrderBy(f => f.Order).ToList();
    }

    private async Task<List<YamletRequest>> LoadRequestsInDirectoryAsync(string directory)
    {
        var requests = new List<YamletRequest>();
        foreach (var file in Directory.EnumerateFiles(directory, "*" + RequestFileService.FileExtension).OrderBy(f => f))
        {
            var fileName = Path.GetFileName(file);
            if (string.Equals(fileName, MetadataFileName, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(fileName, FolderMetadataFileName, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            try
            {
                requests.Add(await _requestFiles.LoadRequestAsync(file).ConfigureAwait(false));
            }
            catch
            {
                // Skip malformed request files.
            }
        }

        // Honor the persisted order; ties keep the alphabetical enumeration order (stable sort).
        return requests.OrderBy(r => r.Order).ToList();
    }

    // ---- Creation ----------------------------------------------------------

    public async Task<YamletCollection> CreateCollectionAsync(YamletWorkspace workspace, string name)
    {
        Directory.CreateDirectory(workspace.CollectionsPath);
        var dir = PathNaming.UniqueDirectoryPath(workspace.CollectionsPath, PathNaming.Slugify(name, "collection"));
        Directory.CreateDirectory(dir);

        var collection = new YamletCollection
        {
            Name = name,
            DirectoryPath = dir,
            FilePath = Path.Combine(dir, MetadataFileName),
        };

        await SaveCollectionAsync(collection).ConfigureAwait(false);
        return collection;
    }

    /// <summary>Creates a folder on disk under a collection or another folder.</summary>
    public YamletFolder CreateFolder(YamletCollection collection, YamletFolder? parent, string name)
    {
        var parentDir = parent?.DirectoryPath ?? collection.DirectoryPath
            ?? throw new InvalidOperationException("Collection has no directory.");

        var dir = PathNaming.UniqueDirectoryPath(parentDir, PathNaming.Slugify(name, "folder"));
        Directory.CreateDirectory(dir);

        var siblings = parent?.Folders ?? collection.Folders;
        var folder = new YamletFolder { Name = name, DirectoryPath = dir, Order = siblings.Count };
        siblings.Add(folder);
        return folder;
    }

    /// <summary>
    /// Creates a new request and assigns it a file path under the given folder (or the
    /// collection root). The file is not written until saved.
    /// </summary>
    public YamletRequest CreateRequest(YamletCollection collection, YamletFolder? parent, string name)
    {
        var parentDir = parent?.DirectoryPath ?? collection.DirectoryPath
            ?? throw new InvalidOperationException("Collection has no directory.");
        Directory.CreateDirectory(parentDir);

        var fileName = PathNaming.Slugify(name, "request") + RequestFileService.FileExtension;
        var path = PathNaming.UniqueFilePath(parentDir, fileName);

        var siblings = parent?.Requests ?? collection.Requests;
        var request = new YamletRequest { Name = name, SourceFilePath = path, Order = siblings.Count };
        siblings.Add(request);
        return request;
    }

    // ---- Saving ------------------------------------------------------------

    /// <summary>
    /// Writes the collection's <c>collection.yaml</c> metadata (id, name, variables, auth,
    /// scripts) and each folder's <c>folder.yaml</c>. Request file contents are the single
    /// source of truth for requests and are saved separately via
    /// <see cref="RequestFileService.SaveRequestAsync"/> — they are not embedded here.
    /// </summary>
    public async Task SaveCollectionAsync(YamletCollection collection)
    {
        if (string.IsNullOrWhiteSpace(collection.DirectoryPath))
        {
            throw new InvalidOperationException("Collection has no directory path.");
        }

        Directory.CreateDirectory(collection.DirectoryPath);
        collection.FilePath = Path.Combine(collection.DirectoryPath, MetadataFileName);

        // Yamlet-native metadata only; requests live in their own files (ordered by `order`).
        var dto = CollectionDto.FromDomain(collection);
        await File.WriteAllTextAsync(collection.FilePath, _yaml.Serialize(dto)).ConfigureAwait(false);

        await EnsureFolderMetadataAsync(collection.Folders).ConfigureAwait(false);
    }

    /// <summary>
    /// Renumbers the direct children of a container (a collection root, or a folder within
    /// it) to match their current in-memory list order and persists each affected file.
    /// Call this after a structural change (create, move, duplicate, delete, reorder) so the
    /// on-disk <c>order</c> reflects the tree.
    /// </summary>
    public async Task SaveContainerOrderAsync(YamletCollection collection, YamletFolder? folder)
    {
        var requests = folder?.Requests ?? collection.Requests;
        for (var i = 0; i < requests.Count; i++)
        {
            requests[i].Order = i;
            if (!string.IsNullOrWhiteSpace(requests[i].SourceFilePath))
            {
                await _requestFiles.SaveRequestAsync(requests[i]).ConfigureAwait(false);
            }
        }

        var folders = folder?.Folders ?? collection.Folders;
        for (var i = 0; i < folders.Count; i++)
        {
            folders[i].Order = i;
            await WriteFolderMetadataAsync(folders[i]).ConfigureAwait(false);
        }
    }

    private async Task EnsureFolderMetadataAsync(IEnumerable<YamletFolder> folders)
    {
        foreach (var folder in folders)
        {
            await WriteFolderMetadataAsync(folder).ConfigureAwait(false);
            await EnsureFolderMetadataAsync(folder.Folders).ConfigureAwait(false);
        }
    }

    private async Task WriteFolderMetadataAsync(YamletFolder folder)
    {
        if (string.IsNullOrWhiteSpace(folder.DirectoryPath))
        {
            return;
        }

        Directory.CreateDirectory(folder.DirectoryPath);
        var path = Path.Combine(folder.DirectoryPath, FolderMetadataFileName);
        await File.WriteAllTextAsync(path, _yaml.Serialize(FolderDto.FromDomain(folder))).ConfigureAwait(false);
    }
}
