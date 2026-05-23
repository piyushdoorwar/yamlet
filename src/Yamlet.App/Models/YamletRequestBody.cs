namespace Yamlet.App.Models;

/// <summary>
/// Body content types Yamlet understands. For the MVP only <see cref="None"/>,
/// <see cref="Raw"/> and <see cref="Json"/> are wired through to execution; the
/// remaining values are accepted and persisted so files round-trip.
/// </summary>
public enum YamletBodyType
{
    None,
    Raw,
    Json,
    FormData,
    UrlEncoded,
}

/// <summary>
/// The request payload. Only <see cref="Raw"/> text is sent for the MVP body types.
/// </summary>
public sealed class YamletRequestBody
{
    public YamletBodyType Type { get; set; } = YamletBodyType.None;

    /// <summary>Raw text payload used for the Raw and JSON body types.</summary>
    public string Raw { get; set; } = string.Empty;

    public YamletRequestBody Clone() => new()
    {
        Type = Type,
        Raw = Raw,
    };
}
