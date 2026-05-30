using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Yamlet.App.Models;

namespace Yamlet.App.Services;

/// <summary>
/// Obtains OAuth 2.0 access tokens from a token endpoint. Supports the
/// client-credentials grant (fetched + cached automatically) and the
/// authorization-code grant's token exchange (code → token). All fields passed in are
/// expected to be already variable-resolved. The <see cref="HttpClient"/> is injected
/// so tests can supply a fake handler.
/// </summary>
public sealed class OAuth2TokenService
{
    private readonly HttpClient _client;
    private readonly ConcurrentDictionary<string, CachedToken> _cache = new();

    public OAuth2TokenService(HttpClient client) => _client = client;

    /// <summary>Result of a token request.</summary>
    public sealed record TokenResult(string AccessToken, string RefreshToken, int ExpiresInSeconds);

    /// <summary>
    /// Returns a client-credentials access token, fetching a new one only when the cache
    /// has none or the cached one is near expiry. Cache key is token URL + client + scope.
    /// </summary>
    public async Task<string> GetClientCredentialsTokenAsync(YamletOAuth2 config, CancellationToken cancellationToken)
    {
        var key = $"{config.AccessTokenUrl}|{config.ClientId}|{config.Scope}";
        if (_cache.TryGetValue(key, out var cached) && cached.ExpiresAtUtc > DateTime.UtcNow.AddSeconds(30))
        {
            return cached.AccessToken;
        }

        var form = new List<KeyValuePair<string, string>>
        {
            new("grant_type", "client_credentials"),
        };
        if (!string.IsNullOrWhiteSpace(config.Scope))
        {
            form.Add(new("scope", config.Scope));
        }

        var result = await RequestTokenAsync(config, form, cancellationToken).ConfigureAwait(false);
        _cache[key] = new CachedToken(result.AccessToken, DateTime.UtcNow.AddSeconds(result.ExpiresInSeconds));
        return result.AccessToken;
    }

    /// <summary>Exchanges an authorization code (with PKCE verifier) for tokens.</summary>
    public async Task<TokenResult> ExchangeAuthorizationCodeAsync(
        YamletOAuth2 config,
        string code,
        string codeVerifier,
        CancellationToken cancellationToken)
    {
        var form = new List<KeyValuePair<string, string>>
        {
            new("grant_type", "authorization_code"),
            new("code", code),
            new("redirect_uri", config.RedirectUri),
        };
        if (!string.IsNullOrWhiteSpace(codeVerifier))
        {
            form.Add(new("code_verifier", codeVerifier));
        }

        return await RequestTokenAsync(config, form, cancellationToken).ConfigureAwait(false);
    }

    private async Task<TokenResult> RequestTokenAsync(
        YamletOAuth2 config,
        List<KeyValuePair<string, string>> form,
        CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, config.AccessTokenUrl);

        if (config.ClientAuthentication == OAuth2ClientAuthentication.BasicHeader)
        {
            var basic = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{config.ClientId}:{config.ClientSecret}"));
            request.Headers.Authorization = new AuthenticationHeaderValue("Basic", basic);
        }
        else
        {
            form.Add(new("client_id", config.ClientId));
            if (!string.IsNullOrEmpty(config.ClientSecret))
            {
                form.Add(new("client_secret", config.ClientSecret));
            }
        }

        request.Content = new FormUrlEncodedContent(form);

        using var response = await _client.SendAsync(request, cancellationToken).ConfigureAwait(false);
        var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"Token request failed ({(int)response.StatusCode} {response.ReasonPhrase}): {body}");
        }

        return ParseTokenResponse(body);
    }

    private static TokenResult ParseTokenResponse(string body)
    {
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        var accessToken = root.TryGetProperty("access_token", out var at) ? at.GetString() ?? string.Empty : string.Empty;
        var refreshToken = root.TryGetProperty("refresh_token", out var rt) ? rt.GetString() ?? string.Empty : string.Empty;
        var expiresIn = root.TryGetProperty("expires_in", out var ei) && ei.TryGetInt32(out var seconds) ? seconds : 3600;
        return new TokenResult(accessToken, refreshToken, expiresIn);
    }

    private sealed record CachedToken(string AccessToken, DateTime ExpiresAtUtc);
}
