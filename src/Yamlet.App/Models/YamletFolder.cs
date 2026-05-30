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

    /// <summary>
    /// Position of this folder among its sibling folders within the same directory.
    /// Persisted to the folder's <c>folder.yaml</c> so the tree order survives reloads;
    /// lower sorts first.
    /// </summary>
    public int Order { get; set; }

    /// <summary>Absolute path of the directory backing this folder, if saved.</summary>
    public string? DirectoryPath { get; set; }
}
