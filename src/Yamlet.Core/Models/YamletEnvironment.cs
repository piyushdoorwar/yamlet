namespace Yamlet.App.Models;

/// <summary>
/// A named set of variables (e.g. Local, Dev, Prod) that can be selected as the
/// active environment when resolving <c>{{name}}</c> placeholders.
/// </summary>
public sealed class YamletEnvironment
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string Name { get; set; } = "New Environment";
    public List<YamletVariable> Variables { get; set; } = new();

    /// <summary>Absolute path of the YAML file backing this environment, if saved.</summary>
    public string? FilePath { get; set; }
}
