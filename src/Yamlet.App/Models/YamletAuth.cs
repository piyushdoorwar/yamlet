namespace Yamlet.App.Models;

/// <summary>
/// Supported authorization schemes for a request. Kept intentionally small for the
/// MVP; the model is shaped so inherited/OAuth schemes can be layered on later.
/// </summary>
public enum YamletAuthType
{
    None,
    Bearer,
    Basic,
    ApiKey,
}

/// <summary>
/// Where an API-key credential is placed when applied to a request.
/// </summary>
public enum ApiKeyLocation
{
    Header,
    Query,
}

/// <summary>
/// Authorization settings for a request. Only the fields relevant to the selected
/// <see cref="Type"/> are used when executing; the rest are persisted so switching
/// auth types does not lose previously entered values.
/// </summary>
public sealed class YamletAuth
{
    public YamletAuthType Type { get; set; } = YamletAuthType.None;

    // Bearer
    public string Token { get; set; } = string.Empty;

    // Basic
    public string Username { get; set; } = string.Empty;
    public string Password { get; set; } = string.Empty;

    // ApiKey
    public string ApiKeyName { get; set; } = string.Empty;
    public string ApiKeyValue { get; set; } = string.Empty;
    public ApiKeyLocation ApiKeyIn { get; set; } = ApiKeyLocation.Header;

    public YamletAuth Clone() => new()
    {
        Type = Type,
        Token = Token,
        Username = Username,
        Password = Password,
        ApiKeyName = ApiKeyName,
        ApiKeyValue = ApiKeyValue,
        ApiKeyIn = ApiKeyIn,
    };
}
