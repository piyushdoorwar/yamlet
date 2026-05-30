namespace Yamlet.App.Models;

/// <summary>
/// An opened Yamlet workspace: a root directory containing a <c>yamlet/</c> folder
/// with <c>collections/</c>, <c>environments/</c> and <c>globals/</c> sub-folders.
/// </summary>
public sealed class YamletWorkspace
{
    public string Name { get; set; } = string.Empty;

    /// <summary>Absolute path to the <c>yamlet/</c> directory itself.</summary>
    public string RootPath { get; set; } = string.Empty;

    public string CollectionsPath { get; set; } = string.Empty;
    public string EnvironmentsPath { get; set; } = string.Empty;
    public string GlobalsPath { get; set; } = string.Empty;

    public List<YamletCollection> Collections { get; set; } = new();
    public List<YamletEnvironment> Environments { get; set; } = new();

    /// <summary>Workspace-wide variables loaded from <c>globals/globals.yaml</c>.</summary>
    public List<YamletVariable> Globals { get; set; } = new();
}
