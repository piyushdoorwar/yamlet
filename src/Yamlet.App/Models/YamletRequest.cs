namespace Yamlet.App.Models;

/// <summary>
/// A single HTTP request. This is the in-memory domain model; it is mapped to and
/// from an on-disk YAML representation by the serialization layer rather than being
/// serialized directly, so the UI never depends on the file format.
/// </summary>
public sealed class YamletRequest
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string Name { get; set; } = "New Request";
    public string Method { get; set; } = "GET";
    public string Url { get; set; } = string.Empty;

    public List<YamletHeader> Headers { get; set; } = new();
    public List<YamletQueryParam> QueryParams { get; set; } = new();
    public List<YamletPathVariable> PathVariables { get; set; } = new();
    public YamletRequestBody Body { get; set; } = new();
    public YamletAuth Auth { get; set; } = new();
    public List<YamletVariable> Variables { get; set; } = new();

    /// <summary>Optional free-text description of the request (preserved on save).</summary>
    public string Description { get; set; } = string.Empty;

    /// <summary>Script that runs before the request is sent.</summary>
    public string PreRequestScript { get; set; } = string.Empty;

    /// <summary>Script that runs after a response is received.</summary>
    public string PostResponseScript { get; set; } = string.Empty;

    /// <summary>Absolute path of the YAML file backing this request, if saved.</summary>
    public string? SourceFilePath { get; set; }
}
