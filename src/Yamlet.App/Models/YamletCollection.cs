namespace Yamlet.App.Models;

/// <summary>
/// A collection of API requests. On disk a collection is a directory under
/// <c>yamlet/collections/</c> containing a <c>collection.yaml</c> metadata file plus
/// request files and folder sub-directories.
/// </summary>
public sealed class YamletCollection
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string Name { get; set; } = "New Collection";

    public List<YamletFolder> Folders { get; set; } = new();
    public List<YamletRequest> Requests { get; set; } = new();
    public List<YamletVariable> Variables { get; set; } = new();
    public YamletAuth Auth { get; set; } = new() { Type = YamletAuthType.None };

    /// <summary>Absolute path of the collection's root directory, if saved.</summary>
    public string? DirectoryPath { get; set; }

    /// <summary>Absolute path of the <c>collection.yaml</c> metadata file.</summary>
    public string? FilePath { get; set; }
}
