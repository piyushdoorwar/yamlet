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

        return result;
    }

    private async Task<YamletCollection> LoadCollectionAsync(string directory)
    {
        var collection = new YamletCollection
        {
            DirectoryPath = directory,
            Name = Path.GetFileName(directory),
        };

        var metadataPath = Path.Combine(directory, MetadataFileName);
        collection.FilePath = metadataPath;
        if (File.Exists(metadataPath))
        {
            var dto = _yaml.Deserialize<CollectionDto>(await File.ReadAllTextAsync(metadataPath).ConfigureAwait(false));
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
            var folder = new YamletFolder
            {
                Name = Path.GetFileName(dir),
                DirectoryPath = dir,
                Requests = await LoadRequestsInDirectoryAsync(dir).ConfigureAwait(false),
                Folders = await LoadFoldersAsync(dir).ConfigureAwait(false),
            };
            folders.Add(folder);
        }
        return folders;
    }

    private async Task<List<YamletRequest>> LoadRequestsInDirectoryAsync(string directory)
    {
        var requests = new List<YamletRequest>();
        foreach (var file in Directory.EnumerateFiles(directory, "*" + RequestFileService.FileExtension).OrderBy(f => f))
        {
            if (string.Equals(Path.GetFileName(file), MetadataFileName, StringComparison.OrdinalIgnoreCase))
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
        return requests;
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

        var folder = new YamletFolder { Name = name, DirectoryPath = dir };
        (parent?.Folders ?? collection.Folders).Add(folder);
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

        var request = new YamletRequest { Name = name, SourceFilePath = path };
        (parent?.Requests ?? collection.Requests).Add(request);
        return request;
    }

    // ---- Saving ------------------------------------------------------------

    /// <summary>
    /// Writes the collection's <c>collection.yaml</c> metadata and ensures folder
    /// directories exist. Request file contents are saved separately via
    /// <see cref="RequestFileService.SaveRequestAsync"/>.
    /// </summary>
    public async Task SaveCollectionAsync(YamletCollection collection)
    {
        if (string.IsNullOrWhiteSpace(collection.DirectoryPath))
        {
            throw new InvalidOperationException("Collection has no directory path.");
        }

        Directory.CreateDirectory(collection.DirectoryPath);
        collection.FilePath = Path.Combine(collection.DirectoryPath, MetadataFileName);

        var dto = CollectionDto.FromDomain(collection);
        await File.WriteAllTextAsync(collection.FilePath, _yaml.Serialize(dto)).ConfigureAwait(false);

        EnsureFolderDirectories(collection.Folders);
    }

    private static void EnsureFolderDirectories(IEnumerable<YamletFolder> folders)
    {
        foreach (var folder in folders)
        {
            if (!string.IsNullOrWhiteSpace(folder.DirectoryPath))
            {
                Directory.CreateDirectory(folder.DirectoryPath);
            }
            EnsureFolderDirectories(folder.Folders);
        }
    }
}
