namespace Yamlet.App.Models;

/// <summary>
/// Body content types Yamlet understands and can send.
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
/// One field in a form-data or x-www-form-urlencoded request body.
/// For form-data, file fields can be marked with <see cref="IsFile"/> or by using a
/// value that starts with <c>@</c> followed by a local file path.
/// </summary>
public sealed class YamletBodyField
{
    public string Key { get; set; } = string.Empty;
    public string Value { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public bool Enabled { get; set; } = true;
    public bool IsFile { get; set; }

    public YamletBodyField Clone() => new()
    {
        Key = Key,
        Value = Value,
        Description = Description,
        Enabled = Enabled,
        IsFile = IsFile,
    };
}

/// <summary>
/// The request payload. Raw text is used by Raw/JSON bodies; form body types use
/// <see cref="Fields"/>.
/// </summary>
public sealed class YamletRequestBody
{
    public YamletBodyType Type { get; set; } = YamletBodyType.None;

    /// <summary>Raw text payload used for the Raw and JSON body types.</summary>
    public string Raw { get; set; } = string.Empty;

    /// <summary>Form fields used for form-data and x-www-form-urlencoded body types.</summary>
    public List<YamletBodyField> Fields { get; set; } = new();

    public YamletRequestBody Clone() => new()
    {
        Type = Type,
        Raw = Raw,
        Fields = Fields.Select(f => f.Clone()).ToList(),
    };
}
