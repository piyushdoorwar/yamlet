namespace Yamlet.App.Models;

/// <summary>
/// A grouping of requests (and nested folders) inside a collection. On disk a folder
/// maps to a directory; its requests are the YAML files within it.
/// </summary>
public sealed class YamletFolder
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string Name { get; set; } = "New Folder";

    public List<YamletFolder> Folders { get; set; } = new();
    public List<YamletRequest> Requests { get; set; } = new();

    /// <summary>Absolute path of the directory backing this folder, if saved.</summary>
    public string? DirectoryPath { get; set; }
}
