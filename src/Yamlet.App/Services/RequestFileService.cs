using Yamlet.App.Models;

namespace Yamlet.App.Services;

/// <summary>
/// Reads and writes individual request YAML files, mapping between the on-disk
/// <see cref="RequestDto"/> and the <see cref="YamletRequest"/> domain model.
/// </summary>
public sealed class RequestFileService
{
    public const string FileExtension = ".yaml";

    private readonly YamlSerializationService _yaml;

    public RequestFileService(YamlSerializationService yaml) => _yaml = yaml;

    public async Task<YamletRequest> LoadRequestAsync(string filePath)
    {
        var text = await File.ReadAllTextAsync(filePath).ConfigureAwait(false);
        var dto = _yaml.Deserialize<RequestDto>(text);
        if (string.IsNullOrWhiteSpace(dto.Name))
        {
            dto.Name = DeriveNameFromFile(filePath);
        }
        return dto.ToDomain(filePath);
    }

    /// <summary>
    /// Persists a request to its <see cref="YamletRequest.SourceFilePath"/>. The caller
    /// is responsible for assigning a path (via <see cref="CollectionService"/>) before
    /// the first save.
    /// </summary>
    public async Task SaveRequestAsync(YamletRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.SourceFilePath))
        {
            throw new InvalidOperationException(
                "Request has no file path. Assign one before saving.");
        }

        var dir = Path.GetDirectoryName(request.SourceFilePath);
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
        }

        var dto = RequestDto.FromDomain(request);
        await File.WriteAllTextAsync(request.SourceFilePath, _yaml.Serialize(dto)).ConfigureAwait(false);
    }

    /// <summary>
    /// Derives a readable request name from its file name, dropping the <c>.yaml</c>
    /// extension and a trailing <c>.request</c> qualifier (as used by exported files),
    /// e.g. <c>Get All.request.yaml</c> → <c>Get All</c>.
    /// </summary>
    public static string DeriveNameFromFile(string filePath)
    {
        var name = Path.GetFileNameWithoutExtension(filePath);
        if (name.EndsWith(".request", StringComparison.OrdinalIgnoreCase))
        {
            name = name[..^".request".Length];
        }
        return name;
    }
}
