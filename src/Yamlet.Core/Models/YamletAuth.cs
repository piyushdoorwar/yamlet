namespace Yamlet.App.Models;

/// <summary>
/// Supported authorization schemes for a request or collection.
/// </summary>
public enum YamletAuthType
{
    Inherit,
    None,
    Bearer,
    Basic,
    ApiKey,
    Cookie,
    OAuth2,
}

/// <summary>
/// Where an API-key credential is placed when applied to a request.
/// </summary>
public enum ApiKeyLocation
{
    Header,
    Query,
}

/// <summary>OAuth 2.0 grant types Yamlet can obtain a token with.</summary>
public enum OAuth2GrantType
{
    ClientCredentials,
    AuthorizationCode,
    Password,
}

/// <summary>Where the obtained OAuth2 token is attached to outgoing requests.</summary>
public enum OAuth2TokenLocation
{
    Header,
    Query,
}

/// <summary>How client credentials are sent to the token endpoint.</summary>
public enum OAuth2ClientAuthentication
{
    /// <summary>HTTP Basic header (<c>Authorization: Basic base64(id:secret)</c>).</summary>
    BasicHeader,

    /// <summary>In the request body (<c>client_id</c> / <c>client_secret</c> form fields).</summary>
    Body,
}

/// <summary>
/// OAuth 2.0 configuration. Covers the client-credentials and authorization-code (with
/// PKCE) grants. Placeholder <c>{{variables}}</c> in any string field are resolved at
/// send time, so secrets can live in environment/collection variables.
/// </summary>
public sealed class YamletOAuth2
{
    public OAuth2GrantType GrantType { get; set; } = OAuth2GrantType.ClientCredentials;

    /// <summary>The current access token (fetched, or pasted manually).</summary>
    public string AccessToken { get; set; } = string.Empty;
    public string RefreshToken { get; set; } = string.Empty;

    /// <summary>Token type / scheme used in the Authorization header (usually "Bearer").</summary>
    public string HeaderPrefix { get; set; } = "Bearer";

    public string AccessTokenUrl { get; set; } = string.Empty;
    public string AuthUrl { get; set; } = string.Empty;
    public string ClientId { get; set; } = string.Empty;
    public string ClientSecret { get; set; } = string.Empty;
    public string Scope { get; set; } = string.Empty;
    public string RedirectUri { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string Password { get; set; } = string.Empty;

    public OAuth2TokenLocation AddTokenTo { get; set; } = OAuth2TokenLocation.Header;
    public OAuth2ClientAuthentication ClientAuthentication { get; set; } = OAuth2ClientAuthentication.BasicHeader;

    /// <summary>PKCE challenge method for the authorization-code grant ("S256" or "plain").</summary>
    public string ChallengeAlgorithm { get; set; } = "S256";

    public YamletOAuth2 Clone() => (YamletOAuth2)MemberwiseClone();
}

/// <summary>
/// Authorization settings for a request or collection. Only the fields relevant to the
/// selected <see cref="Type"/> are used when executing; the rest are persisted so
/// switching auth types does not lose previously entered values.
/// </summary>
public sealed class YamletAuth
{
    public YamletAuthType Type { get; set; } = YamletAuthType.Inherit;

    // Bearer
    public string Token { get; set; } = string.Empty;

    // Basic
    public string Username { get; set; } = string.Empty;
    public string Password { get; set; } = string.Empty;

    // ApiKey
    public string ApiKeyName { get; set; } = string.Empty;
    public string ApiKeyValue { get; set; } = string.Empty;
    public ApiKeyLocation ApiKeyIn { get; set; } = ApiKeyLocation.Header;

    // Cookie
    public string Cookie { get; set; } = string.Empty;

    // OAuth2
    public YamletOAuth2 OAuth2 { get; set; } = new();

    public YamletAuth Clone() => new()
    {
        Type = Type,
        Token = Token,
        Username = Username,
        Password = Password,
        ApiKeyName = ApiKeyName,
        ApiKeyValue = ApiKeyValue,
        ApiKeyIn = ApiKeyIn,
        Cookie = Cookie,
        OAuth2 = OAuth2.Clone(),
    };
}
