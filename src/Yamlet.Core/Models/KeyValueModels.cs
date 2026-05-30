namespace Yamlet.App.Models;

/// <summary>
/// A request header. Disabled headers are retained for editing but excluded when
/// the request is executed.
/// </summary>
public sealed class YamletHeader
{
    public string Key { get; set; } = string.Empty;
    public string Value { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public bool Enabled { get; set; } = true;

    public YamletHeader Clone() => new()
    {
        Key = Key,
        Value = Value,
        Description = Description,
        Enabled = Enabled,
    };
}

/// <summary>
/// A URL query-string parameter (the <c>?key=value</c> portion of a request URL).
/// </summary>
public sealed class YamletQueryParam
{
    public string Key { get; set; } = string.Empty;
    public string Value { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public bool Enabled { get; set; } = true;

    public YamletQueryParam Clone() => new()
    {
        Key = Key,
        Value = Value,
        Description = Description,
        Enabled = Enabled,
    };
}

/// <summary>
/// A path variable, e.g. the <c>:id</c> segment in <c>/users/:id</c>. Reserved for
/// future templated-URL support; persisted now so files round-trip cleanly.
/// </summary>
public sealed class YamletPathVariable
{
    public string Key { get; set; } = string.Empty;
    public string Value { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;

    public YamletPathVariable Clone() => new()
    {
        Key = Key,
        Value = Value,
        Description = Description,
    };
}

/// <summary>
/// A named variable usable inside <c>{{name}}</c> placeholders. Shared by
/// collections, environments, globals and requests.
/// </summary>
public sealed class YamletVariable
{
    public string Key { get; set; } = string.Empty;
    public string Value { get; set; } = string.Empty;
    public bool Enabled { get; set; } = true;

    public YamletVariable Clone() => new()
    {
        Key = Key,
        Value = Value,
        Enabled = Enabled,
    };
}
